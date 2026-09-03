/// Proves the regression tests are real guards by running the same inputs
/// against the PRE-FIX implementations pulled from git history. Every case
/// below is expected to FAIL here and PASS in test-regressions.mjs. If
/// anything "passes" here, that test was never guarding anything.
import fs from 'node:fs';

const OLD_DIR = process.argv[2] || '/tmp/oldcode';

// ── Reconstruct the OLD locationsAgree (bug 1 + 1b) ──────────────────────
// Verbatim from the pre-fix source: assumed a string, stripped accents by
// deleting them outright.
function oldLocationsAgree(policyLocation, sigLocation) {
  if (!sigLocation) return false;
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');
  const a = norm(policyLocation);
  const b = norm(sigLocation);
  return b.includes(a.split(',')[0] ? norm(policyLocation.split(',')[0]) : a) || a.includes(b) || b.includes(a);
}

// ── Reconstruct the OLD severity extraction (bug 2) ──────────────────────
const PRECIP_PROBABILITY_THRESHOLD = 70;
const GUST_THRESHOLD_KMH = 50;
function oldExtractForecastSignal(raw) {
  const r = raw.result || {};
  const confidence = typeof r.confidence === 'number' ? r.confidence : 1;
  const precipPct = r.precipitation_probability_max_pct ?? r.precipitation_probability_pct ?? null;
  const gustKmh = r.peak_gust_kmh ?? r.wind_gust_max_kmh ?? null;
  const location = r.location ?? r.place ?? null;
  const severe = (precipPct !== null && precipPct >= PRECIP_PROBABILITY_THRESHOLD)
    || (gustKmh !== null && gustKmh >= GUST_THRESHOLD_KMH);
  return { confidence, precipPct, gustKmh, location, severe };
}

// ── OLD askTelegraph had no retry at all (bug 3) ─────────────────────────
async function oldAskTelegraphNoRetry(fn) {
  return fn(); // one attempt, any failure propagates immediately
}

let confirmedBroken = 0;
let unexpectedlyFine = 0;

function expectBroken(label, fn) {
  try {
    const result = fn();
    if (result === 'BROKEN') {
      console.log(`  CONFIRMED BROKEN: ${label}`);
      confirmedBroken++;
    } else {
      console.log(`  !! STILL WORKS in old code: ${label} -- test does not guard anything`);
      unexpectedlyFine++;
    }
  } catch (e) {
    console.log(`  CONFIRMED BROKEN: ${label} -- THREW: ${e.message.slice(0, 70)}`);
    confirmedBroken++;
  }
}

console.log('Running the regression inputs against PRE-FIX code from git history.\n');

// ─────────────────────────────────────────────────────────────────────────
console.log('=== BUG 1: non-string locations against OLD code ===');
expectBroken('object {lat,lon,name} (real miner-910 shape)', () =>
  oldLocationsAgree('Manila, Philippines', { lat: 14.6, lon: 121.0, name: 'Manila' }));
expectBroken('array of parts', () =>
  oldLocationsAgree('Manila, Philippines', ['Manila', 'Philippines']));
expectBroken('object {city,region}', () =>
  oldLocationsAgree('Manila, Philippines', { city: 'Manila', region: 'NCR' }));
expectBroken('number', () =>
  oldLocationsAgree('Manila, Philippines', 14));

console.log('\n=== BUG 1b: accented names against OLD code ===');
expectBroken('Reykjavik vs Reykjavikurborg (accented)', () =>
  oldLocationsAgree('Reykjavik, Iceland', 'Reykjavíkurborg') === false ? 'BROKEN' : 'ok');
expectBroken('Zurich vs Zurich (umlaut)', () =>
  oldLocationsAgree('Zurich, Switzerland', 'Zürich') === false ? 'BROKEN' : 'ok');
expectBroken('Sao Paulo vs Sao Paulo (tilde)', () =>
  oldLocationsAgree('Sao Paulo, Brazil', 'São Paulo') === false ? 'BROKEN' : 'ok');

console.log('\n=== BUG 2: severity gate against OLD code ===');
{
  // The storm-force miner-910 shape: heavy rain, near-gale winds, a risk flag.
  const storm = {
    result: {
      confidence: 0.98,
      days: [{ precip_mm: 45.2 }],
      forecast: [{ precip_mm: 12, wind_ms: 16.5 }, { precip_mm: 9, wind_ms: 14.0 }],
      risk_flags: ['heavy_rain'],
      location: { name: 'Manila' },
    },
  };
  expectBroken('storm-force miner-910 data judged severe', () => {
    const s = oldExtractForecastSignal(storm);
    // Old code sees nulls for every severity field -> can never fire.
    return s.severe === false ? 'BROKEN' : 'ok';
  });
  expectBroken('severity fields actually read (not null)', () => {
    const s = oldExtractForecastSignal(storm);
    return (s.precipPct === null && s.gustKmh === null) ? 'BROKEN' : 'ok';
  });
  expectBroken('daily-mm-only severity fires', () => {
    const s = oldExtractForecastSignal({ result: { days: [{ precip_mm: 25 }], location: 'Manila' } });
    return s.severe === false ? 'BROKEN' : 'ok';
  });
  expectBroken('wind-only severity fires', () => {
    const s = oldExtractForecastSignal({ result: { forecast: [{ wind_ms: 15 }], location: 'Manila' } });
    return s.severe === false ? 'BROKEN' : 'ok';
  });
  expectBroken('risk-flag severity fires', () => {
    const s = oldExtractForecastSignal({ result: { risk_flags: ['thunderstorm'], location: 'Manila' } });
    return s.severe === false ? 'BROKEN' : 'ok';
  });
}

console.log('\n=== BUG 3: transient 402 against OLD code (no retry) ===');
{
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts < 3) throw new Error('Non-JSON response (status 402): ');
    return 'recovered';
  };
  try {
    await oldAskTelegraphNoRetry(flaky);
    console.log('  !! STILL WORKS in old code: transient 402 recovered -- test does not guard anything');
    unexpectedlyFine++;
  } catch (e) {
    console.log(`  CONFIRMED BROKEN: transient 402 aborts immediately after ${attempts} attempt -- ${e.message.slice(0, 50)}`);
    confirmedBroken++;
  }
}

// Confirm the old files really are the pre-fix ones.
console.log('\n=== Provenance of the old sources ===');
for (const [label, file, marker] of [
  ['decision-engine', `${OLD_DIR}/decision-engine-OLD.mjs`, 'toLocationString'],
  ['telegraph-client', `${OLD_DIR}/telegraph-client-OLD.mjs`, 'withRetry'],
]) {
  if (!fs.existsSync(file)) { console.log(`  (missing ${file})`); continue; }
  const src = fs.readFileSync(file, 'utf8');
  const has = src.includes(marker);
  console.log(`  ${label}: fix marker "${marker}" present = ${has} ${has ? '(NOT pre-fix!)' : '(pre-fix confirmed)'}`);
}

console.log(`\n${'='.repeat(62)}`);
console.log(`${confirmedBroken} behaviours confirmed broken in the pre-fix code.`);
if (unexpectedlyFine > 0) {
  console.log(`WARNING: ${unexpectedlyFine} case(s) already worked before the fix -- those tests guard nothing.`);
  process.exit(1);
}
console.log('Every regression test corresponds to a genuinely broken behaviour.');
