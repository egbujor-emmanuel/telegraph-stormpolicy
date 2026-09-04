/// Regression tests for three bugs found by running the pipeline against
/// live Telegraph signals rather than fixtures. Each case below fails
/// against the code as it was before the fix, so these are guards, not
/// decoration. No network calls and no payments -- runnable in CI.
import {
  extractForecastSignal,
  extractAlertSignal,
  locationsAgree,
  locationNamedInProse,
  toLocationString,
} from './src/decision-engine.mjs';
import { isTransient, withRetry } from './src/telegraph-client.mjs';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS: ${label}${detail ? ' -- ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ' -- ' + detail : ''}`);
    failed++;
  }
}

function noThrow(label, fn) {
  try {
    const v = fn();
    check(label, true, 'returned ' + JSON.stringify(v));
    return v;
  } catch (e) {
    check(label, false, 'THREW: ' + e.message);
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BUG 1: locationsAgree() assumed the signal location was a string and
// called .toLowerCase() on it. Live miners return objects and arrays, and
// the throw propagated out of assessStormRisk far enough to abort an entire
// scheduled sweep -- every other policy went unchecked because of one odd
// response on one policy.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n=== BUG 1: non-string location shapes must not throw ===');
{
  const shapes = [
    ['object {lat,lon,name}', { lat: 14.6, lon: 121.0, name: 'Manila' }],
    ['object {city,region}', { city: 'Manila', region: 'NCR' }],
    ['array of parts', ['Manila', 'Philippines']],
    ['nested display_name', { display_name: 'Manila, Metro Manila, PH' }],
    ['number', 14],
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['boolean (unhandled type)', true],
    ['array of objects', [{ name: 'Manila' }, { country: 'PH' }]],
  ];
  for (const [label, shape] of shapes) {
    noThrow(`locationsAgree tolerates ${label}`, () => locationsAgree('Manila, Philippines', shape));
  }

  // The real shape observed live from miner 910 must still bind correctly.
  check(
    'object {lat,lon,name} from miner 910 binds to its policy',
    locationsAgree('Manila, Philippines', { lat: 14.6, lon: 121.0, name: 'Manila' }) === true,
  );
  check('toLocationString flattens object to readable text',
    toLocationString({ lat: 1, lon: 2, name: 'Manila' }) === 'Manila');
}

// ─────────────────────────────────────────────────────────────────────────
// BUG 1b: accent stripping used to delete the accented letter outright, so
// "Reykjavíkurborg" became "reykjavkurborg" and matched nothing -- a false
// negative that silently suppressed legitimate triggers.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n=== BUG 1b: accented place names must still bind ===');
{
  const cases = [
    ['Reykjavik, Iceland', 'Reykjavíkurborg', true],
    ['Sao Paulo, Brazil', 'São Paulo', true],
    ['Zurich, Switzerland', 'Zürich', true],
    ['Malmo, Sweden', 'Malmö', true],
    // Entity binding must still REJECT genuinely wrong places. These are the
    // cases that matter most: a wrong-place trigger pays out on bad evidence.
    ['Manila, Philippines', 'South China Sea', false],
    ['Cape Town, South Africa', 'Libyan Sea', false],
    ['Jakarta, Indonesia', 'South China Sea', false],
    ['Miami, Florida', 'Reykjavik', false],
  ];
  for (const [policy, sig, expected] of cases) {
    const got = locationsAgree(policy, sig);
    check(`${expected ? 'binds' : 'rejects'}: "${policy}" vs "${sig}"`, got === expected, `got ${got}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BUG 2: the severity gate only read precipitation-probability and
// peak-gust fields. Miner 910 reports hourly `forecast` and daily `days`
// series in mm and m/s instead, so severity evaluated to null and the gate
// could NEVER fire for any location the router sent to that miner. A
// permanently-dead trigger condition that looked like "no storms today".
// ─────────────────────────────────────────────────────────────────────────
console.log('\n=== BUG 2: severity must be derived from whichever shape a miner returns ===');
{
  // Real calm-day shape captured live from miner 910 (Miami).
  const calm910 = extractForecastSignal({
    result: {
      confidence: 0.9875,
      days: [{ precip_mm: 0.66 }, { precip_mm: 0.3 }],
      forecast: [{ precip_mm: 0, wind_ms: 3.41 }, { precip_mm: 0, wind_ms: 1.35 }],
      risk_flags: ['none'],
      location: { lat: 25.77, lon: -80.19, name: 'Miami' },
    },
  });
  check('miner-910 calm: severity actually evaluated, not null', calm910.precipMm !== null && calm910.gustKmh !== null,
    `precipMm=${calm910.precipMm} gustKmh=${calm910.gustKmh?.toFixed(1)}`);
  check('miner-910 calm: correctly NOT severe', calm910.severe === false);

  // Same shape, storm-force values: this is the case that could never fire before.
  const storm910 = extractForecastSignal({
    result: {
      confidence: 0.98,
      days: [{ precip_mm: 45.2 }],
      forecast: [{ precip_mm: 12, wind_ms: 16.5 }, { precip_mm: 9, wind_ms: 14.0 }],
      risk_flags: ['heavy_rain'],
      location: { name: 'Manila' },
    },
  });
  check('miner-910 storm: correctly severe', storm910.severe === true,
    `precipMm=${storm910.precipMm} gustKmh=${storm910.gustKmh.toFixed(1)} flags=${storm910.riskFlags}`);

  // Each severity route must be able to fire on its own.
  check('severity fires on daily mm alone', extractForecastSignal({
    result: { days: [{ precip_mm: 25 }], location: 'Manila' },
  }).severe === true);
  check('severity fires on sustained wind alone', extractForecastSignal({
    result: { forecast: [{ wind_ms: 15 }], location: 'Manila' }, // 54 km/h
  }).severe === true);
  check('severity fires on a risk flag alone', extractForecastSignal({
    result: { risk_flags: ['thunderstorm'], location: 'Manila' },
  }).severe === true);
  check('severity fires on legacy probability field', extractForecastSignal({
    result: { precipitation_probability_max_pct: 100, location: 'Manila' },
  }).severe === true);
  check('severity fires on legacy peak-gust field', extractForecastSignal({
    result: { peak_gust_kmh: 56.3, location: 'Manila' },
  }).severe === true);

  // Below-threshold values must NOT fire -- the gate has to stay meaningful.
  check('sub-threshold mm does not fire', extractForecastSignal({
    result: { days: [{ precip_mm: 5 }], location: 'Manila' },
  }).severe === false);
  check('sub-threshold wind does not fire', extractForecastSignal({
    result: { forecast: [{ wind_ms: 5 }], location: 'Manila' }, // 18 km/h
  }).severe === false);
  check('"none" risk flag is not treated as a flag', extractForecastSignal({
    result: { risk_flags: ['none'], location: 'Manila' },
  }).severe === false);

  // Real daily series captured live from miner 7305 (SkyWire Weather
  // Forecast, Manila). It spells the same measurements differently again:
  // precipitation_mm rather than precip_mm, and wind already in km/h rather
  // than m/s. Saturday's 24.9mm clears the 20mm threshold on its own.
  const skywire = extractForecastSignal({
    result: {
      confidence: 0.95,
      location: 'Manila',
      country: 'Philippines',
      days_covered: 3,
      forecast: [
        { condition: 'light rain showers', date: '2026-09-04', day: 'Friday', high_c: 29, low_c: 26.6, precipitation_mm: 2.6, precipitation_probability_percent: null, wind_gust_kmh: null, wind_speed_kmh: 37.1 },
        { condition: 'heavy rain', date: '2026-09-05', day: 'Saturday', high_c: 28.1, low_c: 25.7, precipitation_mm: 24.9, precipitation_probability_percent: null, wind_gust_kmh: null, wind_speed_kmh: 40 },
        { condition: 'light rain', date: '2026-09-06', day: 'Sunday', high_c: 28.4, low_c: 25.5, precipitation_mm: 7, precipitation_probability_percent: null, wind_gust_kmh: null, wind_speed_kmh: 45 },
      ],
    },
  });
  check('miner-7305 daily series: precipitation read, not null', skywire.precipMm !== null, `precipMm=${skywire.precipMm}`);
  check('miner-7305 daily series: km/h wind read without unit inflation', skywire.gustKmh === 45, `gustKmh=${skywire.gustKmh}`);
  check('miner-7305: the 24.9mm day is severe', skywire.severe === true);
  check('daily entries are not summed into a fake total', skywire.precipMm === 24.9,
    `precipMm=${skywire.precipMm} (2.6+24.9+7 would be 34.5)`);

  // The same shape on a genuinely calm run must still be judged calm.
  const skywireCalm = extractForecastSignal({
    result: {
      location: 'Manila',
      forecast: [
        { date: '2026-09-04', day: 'Friday', precipitation_mm: 1.2, wind_speed_kmh: 12 },
        { date: '2026-09-05', day: 'Saturday', precipitation_mm: 0.4, wind_speed_kmh: 15 },
      ],
    },
  });
  check('miner-7305 calm day: correctly not severe', skywireCalm.severe === false,
    `precipMm=${skywireCalm.precipMm} gustKmh=${skywireCalm.gustKmh}`);

  // Hourly series still accumulate across the window rather than taking a max.
  const hourly = extractForecastSignal({
    result: {
      location: 'Manila',
      forecast: Array.from({ length: 8 }, (_, i) => ({ time: `0${i}:00`, precip_mm: 3, wind_ms: 5 })),
    },
  });
  check('hourly entries are summed across the window', hourly.precipMm === 24, `precipMm=${hourly.precipMm}`);

  // A miner returning nothing usable must fail closed, not open.
  const empty = extractForecastSignal({ result: { location: 'Manila' } });
  check('no severity fields at all -> not severe (fails closed)', empty.severe === false);

  // The alert side, with the real live shape from miner 302.
  const alert = extractAlertSignal({
    result: { risk: 0.57, verdict: 'moderate', place: 'Manila, National Capital Region, Philippines' },
  });
  check('alert 0.57 correctly below 0.60 threshold', alert.severe === false, `risk=${alert.risk}`);
  check('alert 0.82 correctly above threshold',
    extractAlertSignal({ result: { risk: 0.82, verdict: 'high', place: 'Manila' } }).severe === true);
}

// ─────────────────────────────────────────────────────────────────────────
// BUG 3: a transient empty-bodied 402 from the x402 handshake threw all the
// way out and aborted the whole sweep. Transient failures must retry; real
// errors must still fail fast rather than burning the run's time budget.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n=== BUG 3: transient failures retry, permanent ones fail fast ===');
{
  check('empty-bodied 402 classified transient', isTransient(new Error('Non-JSON response (status 402): ')) === true);
  check('429 classified transient', isTransient(new Error('Engine ask failed (status 429): {}')) === true);
  check('503 classified transient', isTransient(new Error('Engine ask failed (status 503): {}')) === true);
  check('network reset classified transient', isTransient(new Error('fetch failed ECONNRESET')) === true);
  check('400 NOT classified transient', isTransient(new Error('Engine ask failed (status 400): bad query')) === false);
  check('contract revert NOT classified transient', isTransient(new Error('execution reverted: "only agent"')) === false);
  check('undefined error does not throw classifier', isTransient(undefined) === false);

  // Succeeds on a later attempt: the exact real-world 402 scenario.
  let attempts = 0;
  const recovered = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error('Non-JSON response (status 402): ');
    return 'recovered';
  }, { delayMs: 1 });
  check('retries a transient failure until it succeeds', recovered === 'recovered' && attempts === 3, `attempts=${attempts}`);

  // Permanent failure must not be retried at all.
  let permAttempts = 0;
  try {
    await withRetry(async () => {
      permAttempts++;
      throw new Error('Engine ask failed (status 400): bad query');
    }, { delayMs: 1 });
    check('permanent failure rethrows', false, 'did not throw');
  } catch (e) {
    check('permanent failure rethrows without retrying', permAttempts === 1, `attempts=${permAttempts}`);
  }

  // Exhausted retries must surface the original error, not swallow it.
  let exhausted = 0;
  try {
    await withRetry(async () => {
      exhausted++;
      throw new Error('Non-JSON response (status 402): ');
    }, { attempts: 3, delayMs: 1 });
    check('exhausted retries rethrow', false, 'did not throw');
  } catch (e) {
    check('exhausted retries rethrow the original error', exhausted === 3 && e.message.includes('402'), `attempts=${exhausted}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BUG 4: extractAlertSignal had the same dead-gate flaw as bug 2, and it
// went unnoticed because bug 2 was fixed only on the forecast side. Miner
// 7306 ("SkyWire Storm Alert") returns level/breach/official_alerts plus
// raw measurements and no `risk` at all, so risk fell back to a constant
// 0.25 -- permanently below the 0.6 threshold. The alert gate could never
// fire for that miner however severe the actual weather was.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n=== BUG 4: alert risk must derive from whichever shape a miner returns ===');
{
  // Real calm shape captured live from miner 7306 (Manila, quiet day).
  const calm7306 = extractAlertSignal({
    result: {
      location: 'Manila', country: 'Philippines', level: 'none', breach: false,
      confidence: 0.95, peak_gust_kmh: null, peak_wind_kmh: 36,
      total_precipitation_mm: 10.5, thunderstorms: false, official_alerts: [],
    },
  });
  check('miner-7306 calm: risk actually derived, not the 0.25 fallback',
    calm7306.risk !== null && calm7306.risk !== 0.25, `risk=${calm7306.risk}`);
  check('miner-7306 calm: correctly NOT severe', calm7306.severe === false);
  check('miner-7306 calm: location binds (location+country joined)',
    locationsAgree('Manila, Philippines', calm7306.location) === true, `location="${calm7306.location}"`);

  // Same miner, storm conditions: the case that could never fire before.
  const storm7306 = extractAlertSignal({
    result: {
      location: 'Manila', country: 'Philippines', level: 'warning', breach: true,
      confidence: 0.95, peak_gust_kmh: 94, peak_wind_kmh: 70,
      total_precipitation_mm: 62.0, thunderstorms: true,
      official_alerts: [{ event: 'Tropical Cyclone Warning' }],
    },
  });
  check('miner-7306 storm: correctly severe', storm7306.severe === true, `risk=${storm7306.risk}`);

  // Each alert route must be able to fire on its own.
  check('official alert alone fires',
    extractAlertSignal({ result: { official_alerts: [{ event: 'Gale Warning' }], location: 'Manila' } }).severe === true);
  check('threshold breach alone fires',
    extractAlertSignal({ result: { breach: true, location: 'Manila' } }).severe === true);
  check('"warning" level alone fires',
    extractAlertSignal({ result: { level: 'warning', location: 'Manila' } }).severe === true);
  check('storm-force gust alone fires',
    extractAlertSignal({ result: { peak_gust_kmh: 94, location: 'Manila' } }).severe === true);
  check('legacy risk+verdict shape still works',
    extractAlertSignal({ result: { risk: 0.82, verdict: 'high', place: 'Manila' } }).severe === true);

  // Caught by these tests during the fix: taking the max across indications
  // let the coarse word "moderate" (0.60) override the miner's own precise
  // risk of 0.57 and trip the gate -- a false positive in the payout
  // direction. An explicit number must never be inflated by its own label.
  check('explicit 0.57 is NOT inflated by its "moderate" label',
    extractAlertSignal({ result: { risk: 0.57, verdict: 'moderate', place: 'Manila' } }).severe === false,
    `risk=${extractAlertSignal({ result: { risk: 0.57, verdict: 'moderate', place: 'Manila' } }).risk}`);
  check('explicit 0.30 is NOT inflated by a "warning" label',
    extractAlertSignal({ result: { risk: 0.30, level: 'warning', place: 'Manila' } }).severe === false);
  check('explicit risk still fires when genuinely high',
    extractAlertSignal({ result: { risk: 0.91, level: 'none', place: 'Manila' } }).severe === true);
  check('percentage-scale risk (0-100) is normalized',
    extractAlertSignal({ result: { risk: 82, place: 'Manila' } }).severe === true);

  // Calm conditions must still hold, or the gate is worthless.
  check('"none" level does not fire',
    extractAlertSignal({ result: { level: 'none', breach: false, location: 'Manila' } }).severe === false);
  check('light wind/precip do not fire',
    extractAlertSignal({ result: { peak_wind_kmh: 20, total_precipitation_mm: 2, location: 'Manila' } }).severe === false);

  // Nothing usable -> null, and the caller must not crash formatting it.
  const nothing = extractAlertSignal({ result: { location: 'Manila' } });
  check('no usable evidence -> risk null (not a fake 0.25)', nothing.risk === null, `risk=${nothing.risk}`);
  check('no usable evidence -> not severe (fails closed)', nothing.severe === false);
  noThrow('null risk is formattable without throwing', () =>
    nothing.risk === null ? 'no usable risk evidence' : nothing.risk.toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────────
// BUG 5: miner 4433 ("LiveCert Operational Signals") answers WEATHER_FORECAST
// with the numbers embedded in an English sentence and no structured fields
// at all -- so severity was null and location was null, holding forever.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n=== BUG 5: prose-only miners must still yield severity and bind ===');
{
  // Verbatim prose captured live from miner 4433.
  const realProse = 'A 24-hour hourly weather forecast for Manila, National Capital Region, Philippines covering September 3 to September 4, 2026: hourly temperature in Celsius from 26.2°C to 28.5°C, a precipitation probability of up to 96%, 8.8 mm of total precipitation, the expected condition is drizzle, and a wind speed of up to 25.5 km/h, from the Open-Meteo weather service.';
  const prose4433 = extractForecastSignal({ result: { confidence: 1, reason: realProse, verdict: 'drizzle' } });

  check('prose: precipitation probability parsed', prose4433.precipPct === 96, `precipPct=${prose4433.precipPct}`);
  check('prose: precipitation mm parsed', prose4433.precipMm === 8.8, `precipMm=${prose4433.precipMm}`);
  check('prose: wind km/h parsed', prose4433.gustKmh === 25.5, `gustKmh=${prose4433.gustKmh}`);
  check('prose: flagged as prose-derived evidence', prose4433.derivedFrom === 'prose');
  check('prose: 96% precip crosses the 70% gate', prose4433.severe === true);
  check('prose: policy city named in text binds', locationNamedInProse('Manila, Philippines', realProse) === true);

  // The critical false-positive risk: temperature must never be read as wind.
  const tempOnly = extractForecastSignal({
    result: { confidence: 1, reason: 'hourly temperature in Celsius from 26.2°C to 88.5°C and calm conditions' },
  });
  check('prose: temperature is NOT misread as wind speed', tempOnly.gustKmh === null, `gustKmh=${tempOnly.gustKmh}`);
  check('prose: temperature-only text is not severe', tempOnly.severe === false);

  // Prose binding must still reject the wrong place.
  check('prose: wrong-place text does not bind',
    locationNamedInProse('Jakarta, Indonesia', realProse) === false);
  check('prose: empty text does not bind',
    locationNamedInProse('Manila, Philippines', '') === false);
  check('prose: structured fields still win over prose',
    extractForecastSignal({
      result: { precipitation_probability_max_pct: 10, reason: 'precipitation probability of up to 96%' },
    }).precipPct === 10);
}

console.log(`\n${'='.repeat(62)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
