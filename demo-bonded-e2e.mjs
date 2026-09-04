import { config } from 'dotenv';
config({ quiet: true });
import { ethers } from 'ethers';
import { getBondedContract, LIVENESS_SECONDS, BONDED_ADDRESS, ARBITER_ADDRESS, MIN_BOND_WEI, BOND_BPS } from './src/bonded-client.mjs';
import { sweepBonded, finalizeMatured } from './src/bonded-monitor.mjs';

const LOCATION = process.argv[2] || 'Manila, Philippines';
const PAYOUT = ethers.parseEther('0.000005');

(async () => {
  const { contract, wallet } = getBondedContract();

  console.log('=== StormPolicy bonded end-to-end, live Telegraph signals ===');
  console.log('contract:', BONDED_ADDRESS);
  console.log('agent:   ', wallet.address);
  console.log('arbiter: ', ARBITER_ADDRESS);
  console.log('bond: max(' + ethers.formatEther(MIN_BOND_WEI) + ' ETH, ' + (Number(BOND_BPS) / 100) + '% of payout)   liveness:', LIVENESS_SECONDS, 's');
  console.log('location:', LOCATION);

  console.log('\n--- creating policy ---');
  let tx = await contract.createPolicy(wallet.address, LOCATION, { value: PAYOUT });
  const receipt = await tx.wait();
  const created = receipt.logs
    .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find(l => l && l.name === 'PolicyCreated');
  const policyId = created.args.policyId;
  console.log('policy', policyId.toString(), 'created, tx', tx.hash);

  console.log('\n--- sweep: real Telegraph calls, then bonded assertion ---');
  const result = await sweepBonded();
  console.log(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  const a = await contract.getAssertion(policyId);
  if (Number(a.state) !== 1) {
    console.log('\nNo assertion pending for this policy -- the live signals did not corroborate.');
    console.log('That is the decision engine working, not a failure. Nothing to finalize.');
    return;
  }

  const waitMs = (Number(a.livenessEnds) - Math.floor(Date.now() / 1000) + 5) * 1000;
  console.log(`\n--- dispute window open; waiting ${Math.round(waitMs / 1000)}s for it to close ---`);
  await new Promise(r => setTimeout(r, Math.max(waitMs, 0)));

  console.log('\n--- finalizing undisputed assertion ---');
  const finalized = await finalizeMatured();
  console.log(JSON.stringify(finalized, null, 2));

  const p = await contract.getPolicy(policyId);
  console.log('\npolicy triggered:', p.triggered, '  active:', p.active);
})().catch(e => { console.error('E2E FAILED:', e); process.exit(1); });
