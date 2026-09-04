import fs from 'node:fs';
import path from 'node:path';
import { sweepBonded } from '../src/bonded-monitor.mjs';

// Finalize anything whose dispute window has closed unchallenged, then stake
// a bonded assertion for any active policy whose live signals corroborate.
// A run that dies partway still knows something worth publishing, and a
// silent page is indistinguishable from a stopped agent.
let result = { finalized: [], asserted: [] };
let sweepError = null;
try {
  result = await sweepBonded();
  console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
} catch (err) {
  sweepError = err.shortMessage || err.message;
  console.error('sweep failed partway:', sweepError);
}

// Publish what the agent just decided. Without this the site can only show
// what is already on-chain, so a visitor sees the payouts that fired and no
// trace of the far more common case -- conditions checked, threshold not
// met, nothing done. The holds are most of the evidence that this thing
// actually discriminates rather than paying on anything that moves.
const decisions = (result.asserted ?? []).map(entry => ({
  policyId: String(entry.policyId),
  location: entry.location ?? null,
  triggered: Boolean(entry.asserted),
  // A policy whose signals could not be fetched was still checked. Dropping
  // those made an upstream outage look like an idle agent, which is a worse
  // lie than saying the signal was unavailable.
  unavailable: Boolean(entry.error),
  reason: entry.decision?.reason
    ?? (entry.error ? 'Signals unavailable this run — the request was retried and will be re-checked next sweep.' : null),
  txHash: entry.txHash ?? null,
}));

const summary = {
  sweptAt: new Date().toISOString(),
  citiesAssessed: new Set(decisions.map(d => d.location).filter(Boolean)).size,
  unavailable: decisions.filter(d => d.unavailable).length,
  // Each policy costs one WEATHER_FORECAST and one STORM_ALERT, both
  // auto-routed and paid through x402.
  signalsFetched: decisions.filter(d => !d.unavailable).length * 2,
  triggered: decisions.filter(d => d.triggered).length,
  sweepError,
  finalized: (result.finalized ?? [])
    .filter(f => !f.error)
    .map(f => ({ policyId: String(f.policyId), txHash: f.txHash ?? null })),
  decisions,
};

const out = path.resolve('public/data/latest-sweep.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
console.log(`\nwrote ${out} — ${decisions.length} decisions across ${summary.citiesAssessed} cities`);
