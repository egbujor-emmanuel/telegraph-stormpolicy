import { assessStormRisk } from './decision-engine.mjs';
import { getContract } from './contract-client.mjs';

/// Checks a single policy against live Telegraph signals and, if the
/// cross-corroborated confidence-calibrated decision says so, submits the
/// on-chain trigger with the full evidence trail attached.
export async function checkAndTriggerPolicy(policyId) {
  const { contract } = getContract();
  const p = await contract.getPolicy(policyId);

  if (!p.active) {
    return { policyId, skipped: true, reason: p.triggered ? 'already triggered' : 'cancelled' };
  }

  console.log(`[policy ${policyId}] location="${p.location}" payout=${p.payoutAmount} -- assessing...`);
  const decision = await assessStormRisk(p.location);
  console.log(`[policy ${policyId}] decision: ${decision.shouldTrigger ? 'TRIGGER' : 'HOLD'} -- ${decision.reason}`);

  if (!decision.shouldTrigger) {
    return { policyId, triggered: false, reason: decision.reason, decision };
  }

  const tx = await contract.triggerPayout(
    policyId,
    decision.forecastSignalHash,
    decision.alertSignalHash,
    decision.forecastConfidenceBps,
    decision.alertConfidenceBps,
    decision.reason.slice(0, 500), // keep calldata bounded
  );
  console.log(`[policy ${policyId}] triggerPayout tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[policy ${policyId}] confirmed in block ${receipt.blockNumber}, status ${receipt.status === 1 ? 'success' : 'FAILED'}`);

  return { policyId, triggered: true, txHash: tx.hash, blockNumber: receipt.blockNumber, decision };
}

/// Sweeps every policy the contract knows about and checks each active one.
export async function checkAllPolicies() {
  const { contract } = getContract();
  const next = await contract.nextPolicyId();
  const results = [];
  for (let id = 0n; id < next; id++) {
    const p = await contract.getPolicy(id);
    if (!p.active) continue;
    // One policy's failure must not abort the sweep for every other policy.
    try {
      results.push(await checkAndTriggerPolicy(id));
    } catch (err) {
      console.error(`[policy ${id}] check failed: ${err.message}`);
      results.push({ policyId: id.toString(), error: err.message });
    }
  }
  return results;
}
