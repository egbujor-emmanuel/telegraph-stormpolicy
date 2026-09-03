/// Measures what a consumer of Telegraph's auto-routed Engine API actually
/// receives in practice: which miners the router selects for a given intent,
/// and how the responses are shaped.
///
/// Auto-routed (`/engine/v1/ask`) rather than a pinned miner ID, so the
/// router's own ranking and selection decide who answers -- the same path a
/// real application takes. Every call is a real, x402-paid request.
///
/// Raw results are appended to study-results.json as they arrive so a long
/// run can be stopped and resumed without losing paid calls.
import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { askTelegraph } from './src/telegraph-client.mjs';
import { extractForecastSignal, extractAlertSignal, locationsAgree, locationNamedInProse } from './src/decision-engine.mjs';

const OUT = './study-results.json';

// Deliberately spread across hemispheres, climates and scripts, including
// accented names, so the sample isn't one region's miners answering.
const LOCATIONS = [
  'Manila, Philippines',
  'Jakarta, Indonesia',
  'Miami, Florida',
  'Reykjavik, Iceland',
  'Cape Town, South Africa',
  'Tokyo, Japan',
  'Mumbai, India',
  'London, United Kingdom',
  'Sydney, Australia',
  'Sao Paulo, Brazil',
  'Zurich, Switzerland',
  'Lagos, Nigeria',
];

const REPEATS = Number(process.env.STUDY_REPEATS || 2);

const INTENTS = {
  WEATHER_FORECAST: loc => `What is the 24-hour weather forecast for ${loc} starting today, including temperature, precipitation probability, and wind speed?`,
  STORM_ALERT: loc => `Is there an active storm alert or severe weather warning for ${loc} right now?`,
};

/// A reasonable single-shape integration: reads the canonical structured
/// field names and nothing else. This is the baseline the adapter is
/// measured against.
function baselineForecast(result) {
  const r = result || {};
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const precipPct = n(r.precipitation_probability_max_pct) ?? n(r.precipitation_probability_pct);
  const gustKmh = n(r.peak_gust_kmh) ?? n(r.wind_gust_max_kmh);
  return {
    derivedSeverity: precipPct !== null || gustKmh !== null,
    usableLocation: typeof r.location === 'string' || typeof r.place === 'string',
  };
}

function baselineAlert(result) {
  const r = result || {};
  const risk = typeof r.risk === 'number'
    ? r.risk
    : (r.verdict === 'high' ? 0.75 : r.verdict === 'medium' ? 0.5 : null);
  return {
    derivedSeverity: risk !== null,
    usableLocation: typeof r.place === 'string' || typeof r.location === 'string',
  };
}

const load = () => (fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : []);
const save = rows => fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));

const rows = load();
const done = new Set(rows.map(r => `${r.intent}|${r.location}|${r.repeat}`));
console.log(`Resuming with ${rows.length} calls already recorded.\n`);

for (let repeat = 1; repeat <= REPEATS; repeat++) {
  for (const location of LOCATIONS) {
    for (const [intent, buildQuery] of Object.entries(INTENTS)) {
      const key = `${intent}|${location}|${repeat}`;
      if (done.has(key)) continue;

      process.stdout.write(`[${rows.length + 1}] ${intent} ${location} (run ${repeat}) ... `);
      try {
        const raw = await askTelegraph(buildQuery(location));
        const result = raw.result || {};
        const shape = Object.keys(result).sort();

        const adapter = intent === 'WEATHER_FORECAST'
          ? (() => {
              const f = extractForecastSignal(raw);
              return {
                derivedSeverity: f.precipPct !== null || f.precipMm !== null || f.gustKmh !== null || f.riskFlags.length > 0,
                usableLocation: Boolean(f.location) || locationNamedInProse(location, f.prose),
                boundToPolicy: f.location ? locationsAgree(location, f.location) : locationNamedInProse(location, f.prose),
                derivedFrom: f.derivedFrom,
                severe: f.severe,
              };
            })()
          : (() => {
              const a = extractAlertSignal(raw);
              return {
                derivedSeverity: a.risk !== null,
                usableLocation: Boolean(a.location),
                boundToPolicy: a.location ? locationsAgree(location, a.location) : false,
                derivedFrom: 'structured',
                severe: a.severe,
              };
            })();

        const baseline = intent === 'WEATHER_FORECAST' ? baselineForecast(result) : baselineAlert(result);

        rows.push({
          intent, location, repeat,
          routedIntent: raw.intent,
          minerId: raw.miner_id,
          minerName: raw.miner_name,
          costUsd: raw.cost_usd,
          durationMs: raw.duration_ms,
          shape,
          shapeKey: shape.join(','),
          baseline,
          adapter,
          at: new Date().toISOString(),
        });
        save(rows);
        console.log(`miner ${raw.miner_id} (${raw.miner_name}) | baseline severity: ${baseline.derivedSeverity ? 'yes' : 'NO'} | adapter: ${adapter.derivedSeverity ? 'yes' : 'no'}`);
      } catch (err) {
        rows.push({ intent, location, repeat, error: String(err.message).slice(0, 200), at: new Date().toISOString() });
        save(rows);
        console.log(`call failed: ${String(err.message).slice(0, 80)}`);
      }
    }
  }
}

console.log(`\nDone. ${rows.length} calls recorded in ${OUT}`);
