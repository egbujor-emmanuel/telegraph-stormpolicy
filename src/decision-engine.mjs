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
const PRECIP_PROBABILITY_THRESHOLD = 70; // percent
const GUST_THRESHOLD_KMH = 50;
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
function extractForecastSignal(raw) {
  const r = raw.result || {};
  const confidence = typeof r.confidence === 'number' ? r.confidence : 1; // absent confidence is not treated as zero-trust, but severity below still gates it
  const precipPct = r.precipitation_probability_max_pct ?? r.precipitation_probability_pct ?? null;
  const gustKmh = r.peak_gust_kmh ?? r.wind_gust_max_kmh ?? null;
  const location = r.location ?? r.place ?? null;
  const severe = (precipPct !== null && precipPct >= PRECIP_PROBABILITY_THRESHOLD)
    || (gustKmh !== null && gustKmh >= GUST_THRESHOLD_KMH);
  return { confidence, precipPct, gustKmh, location, severe, raw };
}

/// Extracts a normalized risk in [0,1] from a STORM_ALERT response.
function extractAlertSignal(raw) {
  const r = raw.result || {};
  const risk = typeof r.risk === 'number' ? r.risk : (r.verdict === 'high' ? 0.75 : r.verdict === 'medium' ? 0.5 : 0.25);
  const location = r.place ?? r.location ?? null;
  const severe = risk >= STORM_RISK_THRESHOLD;
  return { risk, verdict: r.verdict ?? null, location, severe, raw };
}

/// Loose location match: both signals should be talking about the same
/// place the policy actually covers. This is the same entity-binding
/// discipline from this project's WASM scoring work applied here --
/// don't act on a "right severity, wrong place" pairing.
function locationsAgree(policyLocation, sigLocation) {
  if (!sigLocation) return false;
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');
  const a = norm(policyLocation);
  const b = norm(sigLocation);
  return b.includes(a.split(',')[0] ? norm(policyLocation.split(',')[0]) : a) || a.includes(b) || b.includes(a);
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
    reasons.push(`forecast not severe (precip ${forecast.precipPct}%, gust ${forecast.gustKmh}km/h, thresholds ${PRECIP_PROBABILITY_THRESHOLD}%/${GUST_THRESHOLD_KMH}km/h)`);
  }
  if (!alert.severe) {
    ok = false;
    reasons.push(`alert risk ${alert.risk.toFixed(2)} below threshold ${STORM_RISK_THRESHOLD} (verdict: ${alert.verdict})`);
  }

  const reason = ok
    ? `corroborated: forecast confidence ${forecast.confidence.toFixed(2)} (precip ${forecast.precipPct}%, gust ${forecast.gustKmh}km/h) + alert risk ${alert.risk.toFixed(2)} (${alert.verdict}) both cross threshold for ${location}`
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
