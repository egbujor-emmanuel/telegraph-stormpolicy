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

/// Extracts a normalized confidence in [0,1] from a WEATHER_FORECAST
/// response. Different miners can shape their output differently (the
/// docs say so explicitly) -- fall back gracefully rather than throwing
/// when a field is absent.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function extractForecastSignal(raw) {
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

  const hourly = Array.isArray(r.forecast) ? r.forecast : [];
  if (hourly.length) {
    // Prefer an explicit gust field; fall back to sustained wind, which is a
    // strictly harder bar to clear than gusts -- it fails closed, never open.
    const winds = hourly.map(h => num(h?.wind_gust_ms) ?? num(h?.wind_ms)).filter(v => v !== null);
    if (winds.length && gustKmh === null) gustKmh = Math.max(...winds) * 3.6;

    const hourlyPrecip = hourly.map(h => num(h?.precip_mm)).filter(v => v !== null);
    if (hourlyPrecip.length) {
      const total = hourlyPrecip.reduce((a, b) => a + b, 0);
      precipMm = precipMm === null ? total : Math.max(precipMm, total);
    }
  }

  const days = Array.isArray(r.days) ? r.days : [];
  const dailyPrecip = days.map(d => num(d?.precip_mm)).filter(v => v !== null);
  if (dailyPrecip.length) {
    const maxDay = Math.max(...dailyPrecip);
    precipMm = precipMm === null ? maxDay : Math.max(precipMm, maxDay);
  }

  // A miner-declared risk flag ("none" means no flag) is itself a severity signal.
  const riskFlags = Array.isArray(r.risk_flags)
    ? r.risk_flags.filter(f => typeof f === 'string' && f.trim().toLowerCase() !== 'none')
    : [];

  const location = toLocationString(r.location ?? r.place ?? null);
  const severe = (precipPct !== null && precipPct >= PRECIP_PROBABILITY_THRESHOLD)
    || (precipMm !== null && precipMm >= PRECIP_MM_THRESHOLD)
    || (gustKmh !== null && gustKmh >= GUST_THRESHOLD_KMH)
    || riskFlags.length > 0;

  return { confidence, precipPct, precipMm, gustKmh, riskFlags, location, severe, raw };
}

/// Extracts a normalized risk in [0,1] from a STORM_ALERT response.
function extractAlertSignal(raw) {
  const r = raw.result || {};
  const risk = typeof r.risk === 'number' ? r.risk : (r.verdict === 'high' ? 0.75 : r.verdict === 'medium' ? 0.5 : 0.25);
  const location = toLocationString(r.place ?? r.location ?? null);
  const severe = risk >= STORM_RISK_THRESHOLD;
  return { risk, verdict: r.verdict ?? null, location, severe, raw };
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
function locationsAgree(policyLocation, sigLocation) {
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
  if (!forecast.location || !locationsAgree(location, forecast.location)) {
    ok = false;
    reasons.push(`forecast location "${forecast.location}" does not bind to policy location "${location}" -- holding (entity-binding check)`);
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
    reasons.push(`alert risk ${alert.risk.toFixed(2)} below threshold ${STORM_RISK_THRESHOLD} (verdict: ${alert.verdict})`);
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
