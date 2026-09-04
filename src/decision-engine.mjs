import { askTelegraph } from './telegraph-client.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Calibrated thresholds. Not arbitrary numbers: severity thresholds pick
// out genuinely disruptive weather (WMO-adjacent gust/precip conventions),
// and the confidence floor exists because of a concrete lesson from this
// project's own Track 2 work -- a scorer (or a miner) reporting high
// confidence is not the same as it being correct. IP_GEOLOCATION scored
// 100% on a rigorous offline test yet only 7/15 live; we do not repeat
// that mistake here by trusting a single self-reported number uncritically.
// ─────────────────────────────────────────────────────────────────────────
const MIN_FORECAST_CONFIDENCE = 0.5;   // below this, the forecast miner itself isn't sure -- hold regardless of severity
const PRECIP_PROBABILITY_THRESHOLD = 70; // percent, when a miner reports a probability
const PRECIP_MM_THRESHOLD = 20;        // mm over the forecast window; IMD grades 15.6-64.4mm/day "rather heavy to heavy"
const GUST_THRESHOLD_KMH = 50;         // ~Beaufort 7 (near gale), WMO-adjacent
const STORM_RISK_THRESHOLD = 0.6;      // 0-1 scale from STORM_ALERT

function toBps(x01) {
  // clamp to [0,1] then convert to basis points (0-10000) for on-chain storage
  const clamped = Math.max(0, Math.min(1, x01));
  return Math.round(clamped * 10000);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/// One entry of a forecast series, read across the spellings and units
/// different miners use for the same measurement.
function entryPrecipMm(e) {
  return num(e?.precip_mm) ?? num(e?.precipitation_mm) ?? num(e?.rain_mm);
}

function entryPrecipPct(e) {
  return num(e?.precipitation_probability_percent)
    ?? num(e?.precipitation_probability_pct)
    ?? num(e?.precip_probability_pct);
}

/// Wind, normalized to km/h. An explicit gust is preferred; sustained wind
/// is a strictly harder bar to clear than gusts, so falling back to it fails
/// closed rather than open.
function entryGustKmh(e) {
  const kmh = num(e?.wind_gust_kmh) ?? num(e?.wind_speed_kmh) ?? num(e?.wind_kmh);
  if (kmh !== null) return kmh;
  const ms = num(e?.wind_gust_ms) ?? num(e?.wind_ms);
  return ms === null ? null : ms * 3.6;
}

/// Distinguishes an hourly series from a daily one. Hourly precipitation
/// accumulates across the window; daily figures are already totals.
function looksHourly(series) {
  if (series.some(e => e && (e.time != null || e.hour != null || e.datetime != null || e.ts != null))) return true;
  if (series.some(e => e && (e.date != null || e.day != null))) return false;
  return series.length > 24;
}

/// Some miners return no structured fields at all -- miner 4433 ("LiveCert
/// Operational Signals") answers WEATHER_FORECAST with the numbers embedded
/// in an English sentence and nothing else. Reading only structured fields
/// meant severity was permanently null for it, the same dead-gate failure
/// as the hourly/daily-series shape.
///
/// Every pattern below is anchored to BOTH a keyword and its unit, because
/// a bare number grab would happily read "26.2C to 28.5C" as a wind speed.
/// Anything not matched stays null and the gate fails closed.
const PROSE_PATTERNS = {
  precipPct: [
    /precipitation probability[^.]{0,40}?(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*(?:chance|probability)\s+of\s+(?:rain|precipitation|showers)/i,
  ],
  precipMm: [
    /(\d+(?:\.\d+)?)\s*mm\s+of\s+(?:total\s+)?precipitation/i,
    /(?:total\s+)?precipitation[^.]{0,30}?(\d+(?:\.\d+)?)\s*mm/i,
    /rainfall[^.]{0,30}?(\d+(?:\.\d+)?)\s*mm/i,
  ],
  gustKmh: [
    /(?:wind gust|gust)[^.]{0,40}?(\d+(?:\.\d+)?)\s*km\/h/i,
    /wind speed[^.]{0,40}?(\d+(?:\.\d+)?)\s*km\/h/i,
    /winds?[^.]{0,30}?up to\s*(\d+(?:\.\d+)?)\s*km\/h/i,
  ],
};

/// Pulls whatever prose text a miner attached, under any of the field names
/// observed in the wild.
function proseOf(r) {
  return [r.reason, r.summary, r.text, r.description, r.answer]
    .filter(v => typeof v === 'string' && v.trim())
    .join(' ');
}

function fromProse(text, key) {
  if (!text) return null;
  for (const re of PROSE_PATTERNS[key]) {
    const m = text.match(re);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

/// Extracts a normalized confidence in [0,1] from a WEATHER_FORECAST
/// response. Different miners can shape their output differently (the
/// docs say so explicitly) -- fall back gracefully rather than throwing
/// when a field is absent.
export function extractForecastSignal(raw) {
  const r = raw.result || {};
  const confidence = typeof r.confidence === 'number' ? r.confidence : 1; // absent confidence is not treated as zero-trust, but severity below still gates it

  // Miners shape WEATHER_FORECAST output differently. Some report a
  // precipitation probability and a peak gust outright; others (e.g. miner
  // 910) return only an hourly `forecast` series and a daily `days` series
  // carrying millimetres and metres-per-second. Reading just one shape meant
  // severity silently evaluated to null for every location the router sent
  // to the other kind of miner -- the gate could never fire. Derive from
  // whatever is actually present.
  let precipPct = num(r.precipitation_probability_max_pct) ?? num(r.precipitation_probability_pct);
  let gustKmh = num(r.peak_gust_kmh) ?? num(r.wind_gust_max_kmh) ?? num(r.wind_gust_kmh);
  let precipMm = num(r.precipitation_mm);

  // Series entries carry the same measurements under different names and
  // units depending on the miner: `precip_mm` or `precipitation_mm`, wind in
  // m/s or already in km/h. Read whichever is present rather than one
  // spelling, and never let a unit assumption inflate a reading.
  for (const series of [r.forecast, r.days]) {
    if (!Array.isArray(series) || series.length === 0) continue;

    const gusts = series.map(entryGustKmh).filter(v => v !== null);
    if (gusts.length) {
      const seriesGust = Math.max(...gusts);
      gustKmh = gustKmh === null ? seriesGust : Math.max(gustKmh, seriesGust);
    }

    const pcts = series.map(entryPrecipPct).filter(v => v !== null);
    if (pcts.length) {
      const seriesPct = Math.max(...pcts);
      precipPct = precipPct === null ? seriesPct : Math.max(precipPct, seriesPct);
    }

    const precips = series.map(entryPrecipMm).filter(v => v !== null);
    if (precips.length) {
      // Hourly entries accumulate over the window; daily entries already are
      // totals, so summing them would overstate a single day's rainfall.
      const seriesPrecip = looksHourly(series)
        ? precips.reduce((a, b) => a + b, 0)
        : Math.max(...precips);
      precipMm = precipMm === null ? seriesPrecip : Math.max(precipMm, seriesPrecip);
    }
  }

  // A miner-declared risk flag ("none" means no flag) is itself a severity signal.
  const riskFlags = Array.isArray(r.risk_flags)
    ? r.risk_flags.filter(f => typeof f === 'string' && f.trim().toLowerCase() !== 'none')
    : [];

  // Last resort: miners that answer in prose only. Recorded via derivedFrom
  // so a decision made on parsed prose is visibly weaker evidence in the
  // on-chain reason string, not silently equivalent to structured fields.
  const prose = proseOf(r);
  let derivedFrom = 'structured';
  if (precipPct === null && precipMm === null && gustKmh === null && prose) {
    precipPct = fromProse(prose, 'precipPct');
    precipMm = fromProse(prose, 'precipMm');
    gustKmh = fromProse(prose, 'gustKmh');
    if (precipPct !== null || precipMm !== null || gustKmh !== null) derivedFrom = 'prose';
  }

  const location = toLocationString(r.location ?? r.place ?? r.city ?? null);
  const severe = (precipPct !== null && precipPct >= PRECIP_PROBABILITY_THRESHOLD)
    || (precipMm !== null && precipMm >= PRECIP_MM_THRESHOLD)
    || (gustKmh !== null && gustKmh >= GUST_THRESHOLD_KMH)
    || riskFlags.length > 0;

  return { confidence, precipPct, precipMm, gustKmh, riskFlags, location, severe, derivedFrom, prose, raw };
}

/// Severity words used by STORM_ALERT miners, mapped onto the same 0-1
/// risk scale. Observed live across `verdict` (miner 302) and `level`
/// (miner 7306, "SkyWire Storm Alert").
/// Miner 7306 splits the place across `location` and `country`; joining them
/// gives the entity-binding check the full string it expects.
function alertLocation(r) {
  const place = toLocationString(r.place ?? r.location ?? r.city ?? null);
  const country = typeof r.country === 'string' ? r.country.trim() : null;
  return place && country && !place.toLowerCase().includes(country.toLowerCase())
    ? `${place}, ${country}`
    : place;
}

const ALERT_LEVELS = {
  extreme: 0.95, severe: 0.9, warning: 0.9, high: 0.8,
  watch: 0.65, moderate: 0.6, medium: 0.6, advisory: 0.6,
  minor: 0.35, low: 0.3, none: 0.1, clear: 0.1, nil: 0.1,
};

/// Extracts a normalized risk in [0,1] from a STORM_ALERT response.
///
/// Same dead-gate hazard as the forecast side: miner 302 returns
/// `risk`/`verdict`/`place`, while miner 7306 returns `level`/`breach`/
/// `official_alerts` plus raw measurements and no `risk` at all. Reading
/// only the first shape meant risk silently fell back to a constant 0.25
/// for the second -- below threshold always, so the alert gate could never
/// fire no matter how severe the real weather was. Derive from whichever
/// evidence is actually present and take the strongest indication.
export function extractAlertSignal(raw) {
  const r = raw.result || {};
  const indications = [];

  // An explicit numeric risk is the miner's own considered judgment and is
  // strictly more precise than the coarse severity word it also reports.
  // Letting the word participate would round 0.57 ("moderate") up to 0.60
  // and trip the gate -- a false positive in the payout direction. So an
  // explicit number is used alone; everything else only fills its absence.
  const explicit = num(r.risk);
  if (explicit !== null) {
    const risk = explicit > 1 ? explicit / 100 : explicit;
    return {
      risk,
      verdict: r.verdict ?? r.level ?? null,
      location: alertLocation(r),
      severe: risk >= STORM_RISK_THRESHOLD,
      raw,
    };
  }

  const words = [r.verdict, r.level, r.severity, r.alert_level]
    .filter(v => typeof v === 'string')
    .map(v => v.trim().toLowerCase());
  for (const w of words) {
    if (ALERT_LEVELS[w] !== undefined) indications.push(ALERT_LEVELS[w]);
  }

  // An official alert issued by a met authority is the strongest evidence
  // available; a declared threshold breach is nearly as strong.
  if (Array.isArray(r.official_alerts) && r.official_alerts.length > 0) indications.push(0.85);
  if (r.breach === true) indications.push(0.75);
  if (r.thunderstorms === true) indications.push(0.65);

  // Raw measurements, mapped onto the same scale as the forecast gate so
  // the two sides stay consistent about what counts as severe.
  const gust = num(r.peak_gust_kmh) ?? num(r.peak_wind_kmh) ?? num(r.wind_gust_kmh);
  if (gust !== null) indications.push(gust >= GUST_THRESHOLD_KMH ? 0.8 : Math.min(0.55, gust / GUST_THRESHOLD_KMH * 0.55));
  const precip = num(r.total_precipitation_mm) ?? num(r.precipitation_mm);
  if (precip !== null) indications.push(precip >= PRECIP_MM_THRESHOLD ? 0.8 : Math.min(0.55, precip / PRECIP_MM_THRESHOLD * 0.55));

  // Nothing usable at all -> null, not a made-up number. The gate then
  // fails closed rather than sitting at a constant sub-threshold value
  // that merely looks like a real reading.
  const risk = indications.length ? Math.max(...indications) : null;

  const severe = risk !== null && risk >= STORM_RISK_THRESHOLD;
  return { risk, verdict: r.verdict ?? r.level ?? null, location: alertLocation(r), severe, raw };
}

/// Miners are free to shape their output differently, and observed live
/// responses return a location as a plain string, as a nested object, or as
/// an array of parts. Flatten any of those to a comparable string rather
/// than assuming one shape -- an unhandled shape used to throw here, which
/// would take down a whole sweep over one odd response.
export function toLocationString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(toLocationString).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'object') {
    const named = ['name', 'city', 'place', 'location', 'display_name', 'formatted', 'address', 'region', 'admin1', 'country']
      .map(k => (typeof v[k] === 'string' ? v[k].trim() : null))
      .filter(Boolean);
    return named.length ? named.join(', ') : null;
  }
  return null;
}

/// Loose location match: both signals should be talking about the same
/// place the policy actually covers. This is the same entity-binding
/// discipline from this project's WASM scoring work applied here --
/// don't act on a "right severity, wrong place" pairing.
export function locationsAgree(policyLocation, sigLocation) {
  // Decompose accents before stripping, so "Reykjavíkurborg" normalizes to
  // "reykjavikurborg" (matching "reykjavik") instead of losing the accented
  // letter entirely and becoming "reykjavkurborg", which matched nothing.
  const norm = s => (typeof s === 'string' ? s : '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  const sig = norm(toLocationString(sigLocation));
  const policyFull = norm(policyLocation);
  if (!sig || !policyFull) return false;

  // "Manila, Philippines" -> also accept a signal that just says "Manila".
  const policyCity = norm(String(policyLocation).split(',')[0]);

  return (policyCity && sig.includes(policyCity)) || sig.includes(policyFull) || policyFull.includes(sig);
}

/// Weaker fallback for entity binding when a miner returns prose and no
/// location field: require the policy's own city to be named in the text.
/// Deliberately one-directional -- it can only confirm the miner is talking
/// about the right place, never substitute for a location it never gave.
export function locationNamedInProse(policyLocation, prose) {
  if (typeof prose !== 'string' || !prose.trim()) return false;
  // Guard against a 1-2 letter "city" matching almost any text by accident.
  const city = String(policyLocation).split(',')[0].replace(/[^a-zA-Z]/g, '');
  if (city.length < 3) return false;
  // Reuse the same normalization the structured check uses, rather than
  // keeping a second accent-stripping implementation in sync by hand.
  return locationsAgree(policyLocation, prose);
}

/// Renders whichever severity measures the miner actually supplied, so a
/// decision's stated reason reflects the evidence it was really made on.
function describeForecast(f) {
  const parts = [];
  if (f.precipPct !== null && f.precipPct !== undefined) parts.push(`precip ${f.precipPct}%`);
  if (f.precipMm !== null && f.precipMm !== undefined) parts.push(`precip ${Number(f.precipMm).toFixed(1)}mm`);
  if (f.gustKmh !== null && f.gustKmh !== undefined) parts.push(`wind ${Number(f.gustKmh).toFixed(1)}km/h`);
  if (f.riskFlags && f.riskFlags.length) parts.push(`flags ${f.riskFlags.join('/')}`);
  return parts.length ? parts.join(', ') : 'no severity fields reported';
}

/// Runs the full cross-corroboration + confidence-calibration check for a
/// policy's location. Returns a decision object; never throws on a
/// legitimate "hold" -- only on an actual infrastructure failure (a
/// Telegraph call itself failing).
export async function assessStormRisk(location) {
  const [forecastRaw, alertRaw] = await Promise.all([
    askTelegraph(`What is the 24-hour weather forecast for ${location} starting today, including temperature, precipitation probability, and wind speed?`),
    askTelegraph(`Is there an active storm alert or severe weather warning for ${location} right now?`),
  ]);

  if (forecastRaw.intent !== 'WEATHER_FORECAST') {
    return { shouldTrigger: false, reason: `router misclassified forecast query as ${forecastRaw.intent}, not WEATHER_FORECAST -- holding`, forecastRaw, alertRaw };
  }
  if (alertRaw.intent !== 'STORM_ALERT') {
    return { shouldTrigger: false, reason: `router misclassified alert query as ${alertRaw.intent}, not STORM_ALERT -- holding`, forecastRaw, alertRaw };
  }

  const forecast = extractForecastSignal(forecastRaw);
  const alert = extractAlertSignal(alertRaw);

  const reasons = [];
  let ok = true;

  if (forecast.confidence < MIN_FORECAST_CONFIDENCE) {
    ok = false;
    reasons.push(`forecast confidence ${forecast.confidence.toFixed(2)} below floor ${MIN_FORECAST_CONFIDENCE} -- miner itself isn't sure, holding regardless of severity`);
  }
  // A prose-only miner reports no location field, which would make entity
  // binding fail forever for it. Accept the weaker evidence of the policy's
  // own city being named in the text -- that confirms the miner is talking
  // about the right place without inventing a location it never gave.
  const forecastBinds = forecast.location
    ? locationsAgree(location, forecast.location)
    : locationNamedInProse(location, forecast.prose);
  if (!forecastBinds) {
    ok = false;
    reasons.push(forecast.location
      ? `forecast location "${forecast.location}" does not bind to policy location "${location}" -- holding (entity-binding check)`
      : `forecast reported no location and its text does not name "${location}" -- holding (entity-binding check)`);
  }
  if (!alert.location || !locationsAgree(location, alert.location)) {
    ok = false;
    reasons.push(`alert location "${alert.location}" does not bind to policy location "${location}" -- holding (entity-binding check)`);
  }
  if (!forecast.severe) {
    ok = false;
    reasons.push(`forecast not severe (${describeForecast(forecast)}; thresholds ${PRECIP_PROBABILITY_THRESHOLD}%/${PRECIP_MM_THRESHOLD}mm/${GUST_THRESHOLD_KMH}km/h)`);
  }
  if (!alert.severe) {
    ok = false;
    // risk is null when a miner returned nothing usable at all -- say that
    // plainly instead of calling .toFixed() on it and taking down the sweep.
    reasons.push(alert.risk === null
      ? `alert reported no usable risk evidence (verdict: ${alert.verdict ?? 'none'}) -- holding`
      : `alert risk ${alert.risk.toFixed(2)} below threshold ${STORM_RISK_THRESHOLD} (verdict: ${alert.verdict})`);
  }

  const reason = ok
    ? `corroborated: forecast confidence ${forecast.confidence.toFixed(2)} (${describeForecast(forecast)}) + alert risk ${alert.risk.toFixed(2)} (${alert.verdict}) both cross threshold for ${location}`
    : reasons.join('; ');

  return {
    shouldTrigger: ok,
    reason,
    forecastSignalHash: forecastRaw.signal_hash,
    alertSignalHash: alertRaw.signal_hash,
    forecastConfidenceBps: toBps(forecast.confidence),
    alertConfidenceBps: toBps(alert.risk),
    forecast,
    alert,
    forecastRaw,
    alertRaw,
  };
}
