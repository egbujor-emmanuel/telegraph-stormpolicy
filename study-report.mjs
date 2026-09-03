/// Turns the raw study data into the numbers quoted in the README, so the
/// claims there can be regenerated rather than taken on faith.
import fs from 'node:fs';

const rows = JSON.parse(fs.readFileSync('./study-results.json', 'utf8'));
const comparison = fs.existsSync('./study-miner-comparison.json')
  ? JSON.parse(fs.readFileSync('./study-miner-comparison.json', 'utf8'))
  : [];

const ok = rows.filter(r => !r.error);
const pct = (n, d) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));

console.log('# Routed-call study\n');
console.log(`Calls: ${rows.length} (${ok.length} succeeded, ${rows.length - ok.length} failed)`);
console.log(`Locations: ${new Set(ok.map(r => r.location)).size}`);
console.log(`Total cost: $${ok.reduce((a, b) => a + (b.costUsd || 0), 0).toFixed(4)}`);
const durations = ok.map(r => r.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
if (durations.length) {
  console.log(`Latency: median ${durations[Math.floor(durations.length / 2)]}ms, max ${durations[durations.length - 1]}ms`);
}

for (const intent of ['WEATHER_FORECAST', 'STORM_ALERT']) {
  const set = ok.filter(r => r.intent === intent);
  if (!set.length) continue;

  const miners = {};
  for (const r of set) miners[`${r.minerId} (${r.minerName})`] = (miners[`${r.minerId} (${r.minerName})`] || 0) + 1;
  const shapes = new Set(set.map(r => r.shapeKey));

  const baselineSev = set.filter(r => r.baseline.derivedSeverity).length;
  const adapterSev = set.filter(r => r.adapter.derivedSeverity).length;
  const baselineLoc = set.filter(r => r.baseline.usableLocation).length;
  const adapterLoc = set.filter(r => r.adapter.usableLocation).length;
  const bound = set.filter(r => r.adapter.boundToPolicy).length;
  const misrouted = set.filter(r => r.routedIntent !== intent).length;

  console.log(`\n## ${intent}  (n=${set.length})\n`);
  console.log('Miner selected by the router:');
  for (const [m, c] of Object.entries(miners).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m}: ${c}/${set.length} (${pct(c, set.length)}%)`);
  }
  console.log(`Distinct response shapes seen: ${shapes.size}`);
  if (misrouted) console.log(`Routed to a different intent than expected: ${misrouted}`);
  console.log('');
  console.log(`  Severity derivable -- canonical-field reader: ${baselineSev}/${set.length} (${pct(baselineSev, set.length)}%)`);
  console.log(`  Severity derivable -- shape-agnostic adapter: ${adapterSev}/${set.length} (${pct(adapterSev, set.length)}%)`);
  console.log(`  Location usable   -- canonical-field reader: ${baselineLoc}/${set.length} (${pct(baselineLoc, set.length)}%)`);
  console.log(`  Location usable   -- shape-agnostic adapter: ${adapterLoc}/${set.length} (${pct(adapterLoc, set.length)}%)`);
  console.log(`  Bound to the requested place (adapter):      ${bound}/${set.length} (${pct(bound, set.length)}%)`);
}

if (comparison.length) {
  console.log('\n# Direct per-miner comparison (router bypassed)\n');
  for (const f of comparison) {
    if (!f.resultKeys?.length) continue;
    console.log(`${f.intent}  miner ${f.minerId} (${f.minerName ?? 'n/a'})  endpoint ${f.endpoint}`);
    console.log(`  fields: ${f.resultKeys.join(', ')}`);
  }
  for (const intent of ['WEATHER_FORECAST', 'STORM_ALERT']) {
    const set = comparison.filter(f => f.intent === intent && f.resultKeys?.length);
    if (set.length < 2) continue;
    const [a, b] = set;
    const shared = a.resultKeys.filter(k => b.resultKeys.includes(k));
    console.log(`\n${intent}: fields shared between miner ${a.minerId} and ${b.minerId}: ${shared.length ? shared.join(', ') : 'none beyond none'}`);
  }
}
