import { sweepBonded } from '../src/bonded-monitor.mjs';

// Finalize anything whose dispute window has closed unchallenged, then stake
// a bonded assertion for any active policy whose live signals corroborate.
const result = await sweepBonded();
console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
