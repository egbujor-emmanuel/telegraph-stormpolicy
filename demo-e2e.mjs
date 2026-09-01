import { ethers } from 'ethers';
import { getContract } from './src/contract-client.mjs';
import { checkAndTriggerPolicy } from './src/monitor.mjs';

(async () => {
  const { contract, wallet } = getContract();

  console.log('=== Creating a real policy: Manila, Philippines ===');
  const payout = ethers.parseEther('0.00002');
  const tx = await contract.createPolicy(wallet.address, 'Manila, Philippines', { value: payout });
  console.log('createPolicy tx:', tx.hash);
  const receipt = await tx.wait();
  const createdLog = receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(l => l && l.name === 'PolicyCreated');
  const policyId = createdLog.args.policyId;
  console.log('policyId:', policyId.toString(), '| payout:', ethers.formatEther(payout), 'ETH');

  console.log('\n=== Running the monitor against real live Telegraph signals ===');
  const result = await checkAndTriggerPolicy(policyId);
  console.log('\n=== Result ===');
  console.log(JSON.stringify({
    policyId: result.policyId.toString(),
    triggered: result.triggered,
    txHash: result.txHash,
    blockNumber: result.blockNumber,
    reason: result.decision?.reason || result.reason,
    forecastSignalHash: result.decision?.forecastSignalHash,
    alertSignalHash: result.decision?.alertSignalHash,
  }, null, 2));
})().catch(e => { console.error('DEMO FAILED:', e.message); console.error(e.stack); process.exit(1); });
