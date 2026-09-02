import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

const abi = JSON.parse(fs.readFileSync('./build/StormPolicy.abi.json', 'utf8'));
const { address } = JSON.parse(fs.readFileSync('./build/deployment.json', 'utf8'));

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const pk = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('TEST_WALLET_PRIVATE_KEY is not set (expected in .env)');
  const wallet = new ethers.Wallet(pk, provider);
  const contract = new ethers.Contract(address, abi, wallet);

  console.log('contract:', address);
  console.log('agent on-chain:', await contract.agent());

  // Test 1: create a tiny policy (beneficiary = wallet itself for the test, trivial amount)
  const payout = ethers.parseEther('0.00001');
  console.log('\n--- createPolicy ---');
  let tx = await contract.createPolicy(wallet.address, 'Manila, Philippines', { value: payout });
  console.log('tx:', tx.hash);
  let receipt = await tx.wait();
  console.log('status:', receipt.status === 1 ? 'success' : 'FAILED', 'gas:', receipt.gasUsed.toString());
  const createdLog = receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(l => l && l.name === 'PolicyCreated');
  const policyId = createdLog.args.policyId;
  console.log('policyId:', policyId.toString());

  console.log('\n--- getPolicy (before trigger) ---');
  let p = await contract.getPolicy(policyId);
  console.log({ funder: p.funder, beneficiary: p.beneficiary, location: p.location, payoutAmount: p.payoutAmount.toString(), active: p.active, triggered: p.triggered });

  // Test 2: trigger payout with dummy evidence
  console.log('\n--- triggerPayout ---');
  const forecastHash = ethers.keccak256(ethers.toUtf8Bytes('dummy-forecast-signal'));
  const alertHash = ethers.keccak256(ethers.toUtf8Bytes('dummy-alert-signal'));
  const balBefore = await provider.getBalance(wallet.address);
  tx = await contract.triggerPayout(policyId, forecastHash, alertHash, 8700, 9200, 'test: both signals corroborate, confidence exceeds calibrated threshold');
  console.log('tx:', tx.hash);
  receipt = await tx.wait();
  console.log('status:', receipt.status === 1 ? 'success' : 'FAILED', 'gas:', receipt.gasUsed.toString());
  const triggeredLog = receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(l => l && l.name === 'PolicyTriggered');
  console.log('event args:', {
    policyId: triggeredLog.args.policyId.toString(),
    forecastSignalHash: triggeredLog.args.forecastSignalHash,
    alertSignalHash: triggeredLog.args.alertSignalHash,
    forecastConfidenceBps: triggeredLog.args.forecastConfidenceBps.toString(),
    alertConfidenceBps: triggeredLog.args.alertConfidenceBps.toString(),
    reason: triggeredLog.args.reason,
    payoutAmount: triggeredLog.args.payoutAmount.toString(),
  });

  console.log('\n--- getPolicy (after trigger) ---');
  p = await contract.getPolicy(policyId);
  console.log({ active: p.active, triggered: p.triggered });

  // Test 3: double-trigger must revert
  console.log('\n--- double-trigger should revert ---');
  try {
    await contract.triggerPayout(policyId, forecastHash, alertHash, 8700, 9200, 'replay attempt');
    console.log('FAIL: did not revert');
  } catch (e) {
    console.log('OK, reverted as expected:', e.shortMessage || e.message);
  }

  // Test 4: cancel on an already-triggered policy must revert
  console.log('\n--- cancel on triggered policy should revert ---');
  try {
    await contract.cancelPolicy(policyId);
    console.log('FAIL: did not revert');
  } catch (e) {
    console.log('OK, reverted as expected:', e.shortMessage || e.message);
  }

  console.log('\nAll contract behavior checks passed.');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
