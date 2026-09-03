import { assessStormRisk } from './decision-engine.mjs';
import { getBondedContract, AssertionState, AGENT_BOND_WEI } from './bonded-client.mjs';

/// Checks one policy against live Telegraph signals and, if the
/// cross-corroborated decision says trigger, stakes the agent's bond behind
/// an on-chain assertion rather than paying out immediately. The payout only
/// moves later, via finalize(), once the dispute window has closed unchallenged.
export async function assertPolicyIfTriggered(policyId) {
  const { contract } = getBondedContract();
  const p = await contract.getPolicy(policyId);

  if (!p.active) {
    return { policyId, skipped: true, reason: p.triggered ? 'already triggered' : 'cancelled' };
  }

  const existing = await contract.getAssertion(policyId);
  if (Number(existing.state) !== AssertionState.None) {
    return { policyId, skipped: true, reason: `assertion already ${stateName(existing.state)}` };
  }

  console.log(`[policy ${policyId}] location="${p.location}" -- assessing...`);
  const decision = await assessStormRisk(p.location);
  console.log(`[policy ${policyId}] decision: ${decision.shouldTrigger ? 'ASSERT' : 'HOLD'} -- ${decision.reason}`);

  if (!decision.shouldTrigger) {
    return { policyId, asserted: false, reason: decision.reason, decision };
  }

  const tx = await contract.assertTrigger(
    policyId,
    decision.forecastSignalHash,
    decision.alertSignalHash,
    decision.forecastConfidenceBps,
    decision.alertConfidenceBps,
    decision.reason.slice(0, 500),
    { value: AGENT_BOND_WEI },
  );
  console.log(`[policy ${policyId}] assertTrigger tx: ${tx.hash} (bond staked)`);
  const receipt = await tx.wait();
  console.log(`[policy ${policyId}] confirmed in block ${receipt.blockNumber}`);

  return { policyId, asserted: true, txHash: tx.hash, blockNumber: receipt.blockNumber, decision };
}

/// Finalizes any assertion whose dispute window has closed without challenge.
/// Permissionless by design -- the agent runs it here only because it is the
/// party that cares most, but anyone can call it.
export async function finalizeMatured() {
  const { contract, provider } = getBondedContract();
  const next = await contract.nextPolicyId();
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const finalized = [];

  for (let id = 0n; id < next; id++) {
    const a = await contract.getAssertion(id);
    if (Number(a.state) !== AssertionState.Pending) continue;
    if (now < a.livenessEnds) continue;

    // One policy failing must not abort the rest of the sweep.
    try {
      const tx = await contract.finalize(id);
      console.log(`[policy ${id}] finalize tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[policy ${id}] payout released, bond returned (block ${receipt.blockNumber})`);
      finalized.push({ policyId: id.toString(), txHash: tx.hash, blockNumber: receipt.blockNumber });
    } catch (err) {
      console.error(`[policy ${id}] finalize failed: ${err.shortMessage || err.message}`);
      finalized.push({ policyId: id.toString(), error: err.shortMessage || err.message });
    }
  }
  return finalized;
}

/// One full pass: finalize anything that has matured, then look for new
/// policies worth asserting against.
export async function sweepBonded() {
  const finalized = await finalizeMatured();

  const { contract } = getBondedContract();
  const next = await contract.nextPolicyId();
  const asserted = [];
  for (let id = 0n; id < next; id++) {
    const p = await contract.getPolicy(id);
    if (!p.active) continue;
    const a = await contract.getAssertion(id);
    if (Number(a.state) !== AssertionState.None) continue;

    // A transient Telegraph failure on one policy must not stop the others
    // from being assessed -- a scheduled sweep gets one shot per run.
    try {
      asserted.push(await assertPolicyIfTriggered(id));
    } catch (err) {
      console.error(`[policy ${id}] assessment failed: ${err.message}`);
      asserted.push({ policyId: id.toString(), error: err.message });
    }
  }
  return { finalized, asserted };
}

function stateName(state) {
  return ['None', 'Pending', 'Disputed', 'Resolved'][Number(state)] ?? 'Unknown';
}
