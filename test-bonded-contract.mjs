import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

const abi = JSON.parse(fs.readFileSync('./build/StormPolicyBonded.abi.json', 'utf8'));
const deployment = JSON.parse(fs.readFileSync('./build/deployment-bonded.json', 'utf8'));
const keys = JSON.parse(fs.readFileSync('./.bonded-test-keys.json', 'utf8'));

const { address, agentBondWei, livenessSeconds } = deployment;
const BOND = BigInt(agentBondWei);
const PAYOUT = ethers.parseEther('0.000005');

const FORECAST_HASH = ethers.keccak256(ethers.toUtf8Bytes('forecast-signal-test'));
const ALERT_HASH = ethers.keccak256(ethers.toUtf8Bytes('alert-signal-test'));

// Base is an OP-stack chain: a transaction's true cost is the L2 execution
// fee (gasUsed * effectiveGasPrice) PLUS an L1 data fee, which the standard
// receipt fields omit but the RPC exposes as `l1Fee`. Accounting for both
// lets every balance assertion below be exact rather than approximate.
async function txCost(provider, hash) {
  const r = await provider.send('eth_getTransactionReceipt', [hash]);
  const l2 = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
  const l1 = r.l1Fee ? BigInt(r.l1Fee) : 0n;
  return l2 + l1;
}

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

async function expectRevert(label, promiseFn) {
  try {
    const tx = await promiseFn();
    await tx.wait();
    check(label, false, 'did NOT revert');
  } catch (e) {
    check(label, true, (e.shortMessage || e.message).slice(0, 80));
  }
}

async function createPolicy(contract, beneficiary, location) {
  const tx = await contract.createPolicy(beneficiary, location, { value: PAYOUT });
  const receipt = await tx.wait();
  const log = receipt.logs
    .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find(l => l && l.name === 'PolicyCreated');
  return log.args.policyId;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const agent = new ethers.Wallet(process.env.TEST_WALLET_PRIVATE_KEY, provider);
  const arbiter = new ethers.Wallet(keys.arbiterPrivateKey, provider);
  const disputer = new ethers.Wallet(keys.disputerPrivateKey, provider);

  const asAgent = new ethers.Contract(address, abi, agent);
  const asArbiter = new ethers.Contract(address, abi, arbiter);
  const asDisputer = new ethers.Contract(address, abi, disputer);

  console.log('contract:', address);
  console.log('agent:   ', agent.address);
  console.log('arbiter: ', arbiter.address, '(on-chain:', await asAgent.arbiter() + ')');
  console.log('disputer:', disputer.address);
  console.log('bond:', ethers.formatEther(BOND), 'ETH   liveness:', livenessSeconds, 's   payout:', ethers.formatEther(PAYOUT), 'ETH');

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== TEST 1: disputed, arbiter rules agent WAS RIGHT ===');
  {
    const beneficiary = ethers.Wallet.createRandom().address;
    const id = await createPolicy(asAgent, beneficiary, 'Manila, Philippines');
    console.log('  policy', id.toString(), 'created, beneficiary', beneficiary);

    let tx = await asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9100, 8800, 'corroborated: test assertion (agent correct path)', { value: BOND });
    await tx.wait();
    let a = await asAgent.getAssertion(id);
    check('assertion is Pending after assertTrigger', Number(a.state) === 1);

    const disputerBefore = await provider.getBalance(disputer.address);
    tx = await asDisputer.dispute(id, { value: BOND });
    await tx.wait();
    const disputeCost = await txCost(provider, tx.hash);
    a = await asAgent.getAssertion(id);
    check('assertion is Disputed after dispute', Number(a.state) === 2);
    check('disputer recorded', a.disputer.toLowerCase() === disputer.address.toLowerCase());

    const agentBefore = await provider.getBalance(agent.address);
    tx = await asArbiter.resolveDispute(id, true);
    await tx.wait();

    const p = await asAgent.getPolicy(id);
    const beneficiaryBal = await provider.getBalance(beneficiary);
    const agentAfter = await provider.getBalance(agent.address);
    const disputerAfter = await provider.getBalance(disputer.address);

    check('policy marked triggered', p.triggered === true);
    check('policy no longer active', p.active === false);
    check('beneficiary received full payout', beneficiaryBal === PAYOUT, ethers.formatEther(beneficiaryBal) + ' ETH');
    check('agent received own bond + disputer bond (2x bond)', agentAfter - agentBefore === BOND * 2n, '+' + ethers.formatEther(agentAfter - agentBefore) + ' ETH');
    check('disputer lost exactly their bond (slashed)', disputerBefore - disputerAfter - disputeCost === BOND, '-' + ethers.formatEther(disputerBefore - disputerAfter - disputeCost) + ' ETH net of exact fees');
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== TEST 2: disputed, arbiter rules agent WAS WRONG (agent slashed) ===');
  {
    const beneficiary = ethers.Wallet.createRandom().address;
    const id = await createPolicy(asAgent, beneficiary, 'Jakarta, Indonesia');
    console.log('  policy', id.toString(), 'created, beneficiary', beneficiary);

    let tx = await asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 5200, 5100, 'weak: test assertion (agent wrong path)', { value: BOND });
    const ar = await tx.wait();
    const assertGas = ar.gasUsed * ar.gasPrice;

    const disputerBefore = await provider.getBalance(disputer.address);
    tx = await asDisputer.dispute(id, { value: BOND });
    await tx.wait();
    const disputeCost = await txCost(provider, tx.hash);

    const agentBefore = await provider.getBalance(agent.address);
    tx = await asArbiter.resolveDispute(id, false);
    await tx.wait();

    const p = await asAgent.getPolicy(id);
    const beneficiaryBal = await provider.getBalance(beneficiary);
    const agentAfter = await provider.getBalance(agent.address);
    const disputerAfter = await provider.getBalance(disputer.address);

    check('policy still active (not triggered)', p.active === true && p.triggered === false);
    check('beneficiary received NOTHING', beneficiaryBal === 0n);
    check('agent bond NOT returned (slashed)', agentAfter === agentBefore, 'delta ' + ethers.formatEther(agentAfter - agentBefore));
    // The disputer is paid 2 bonds but staked 1, so the net gain is +1 bond.
    check('disputer net +1 bond (own bond back + agent bond slashed to them)', disputerAfter - disputerBefore + disputeCost === BOND, '+' + ethers.formatEther(disputerAfter - disputerBefore + disputeCost) + ' ETH net of exact fees');
    void assertGas;
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== TEST 3: revert guards ===');
  {
    const beneficiary = ethers.Wallet.createRandom().address;
    const id = await createPolicy(asAgent, beneficiary, 'Cebu, Philippines');

    await expectRevert('non-agent cannot assertTrigger', () =>
      asDisputer.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'x', { value: BOND }));
    await expectRevert('assertTrigger with wrong bond amount reverts', () =>
      asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'x', { value: BOND / 2n }));

    let tx = await asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'guard test assertion', { value: BOND });
    await tx.wait();

    await expectRevert('double-assert reverts', () =>
      asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'again', { value: BOND }));
    await expectRevert('agent cannot dispute its own assertion', () =>
      asAgent.dispute(id, { value: BOND }));
    await expectRevert('dispute with non-matching bond reverts', () =>
      asDisputer.dispute(id, { value: BOND / 2n }));
    await expectRevert('finalize before liveness expires reverts', () =>
      asAgent.finalize(id));
    await expectRevert('funder cannot cancel while assertion exists', () =>
      asAgent.cancelPolicy(id));

    tx = await asDisputer.dispute(id, { value: BOND });
    await tx.wait();
    await expectRevert('non-arbiter cannot resolveDispute', () =>
      asAgent.resolveDispute(id, true));

    tx = await asArbiter.resolveDispute(id, false);
    await tx.wait();
    await expectRevert('cannot re-resolve an already resolved dispute', () =>
      asArbiter.resolveDispute(id, true));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== TEST 4: undisputed happy path -- assert, wait out liveness, finalize ===');
  {
    const beneficiary = ethers.Wallet.createRandom().address;
    const id = await createPolicy(asAgent, beneficiary, 'Manila, Philippines');
    console.log('  policy', id.toString(), 'created, beneficiary', beneficiary);

    const tx = await asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 10000, 8200, 'corroborated: undisputed happy path', { value: BOND });
    await tx.wait();
    const a = await asAgent.getAssertion(id);
    const waitMs = (Number(a.livenessEnds) - Math.floor(Date.now() / 1000) + 5) * 1000;
    console.log(`  asserted; waiting ${Math.round(waitMs / 1000)}s for liveness window to close...`);
    await new Promise(r => setTimeout(r, Math.max(waitMs, 0)));

    const agentBefore = await provider.getBalance(agent.address);
    // Finalize from the disputer's wallet to prove it is permissionless.
    const ftx = await asDisputer.finalize(id);
    await ftx.wait();

    const p = await asAgent.getPolicy(id);
    const beneficiaryBal = await provider.getBalance(beneficiary);
    const agentAfter = await provider.getBalance(agent.address);

    check('policy marked triggered', p.triggered === true);
    check('beneficiary received full payout', beneficiaryBal === PAYOUT, ethers.formatEther(beneficiaryBal) + ' ETH');
    check('agent bond returned in full', agentAfter - agentBefore === BOND, '+' + ethers.formatEther(agentAfter - agentBefore) + ' ETH');
    check('finalize was permissionless (called by non-agent)', true);
    console.log('  finalize tx:', ftx.hash);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
