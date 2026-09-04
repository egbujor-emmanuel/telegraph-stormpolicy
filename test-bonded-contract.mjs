import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

const abi = JSON.parse(fs.readFileSync('./build/StormPolicyBonded.abi.json', 'utf8'));
const deployment = JSON.parse(fs.readFileSync('./build/deployment-bonded.json', 'utf8'));
const keys = JSON.parse(fs.readFileSync('./.bonded-test-keys.json', 'utf8'));

const { address, minBondWei, bondBps, livenessSeconds, arbiterTimeoutSeconds } = deployment;
const PAYOUT = ethers.parseEther('0.000005');
// Mirror the contract's own rule rather than hardcoding a figure, so the
// suite stays correct if the deployment parameters change.
const scaled = (PAYOUT * BigInt(bondBps)) / 10000n;
const BOND = scaled < BigInt(minBondWei) ? BigInt(minBondWei) : scaled;

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

  // This public RPC's nonce accounting lags behind recent sends, so a
  // back-to-back suite intermittently reuses a nonce. NonceManager keeps a
  // local count, and the proxy below re-syncs it and retries when the chain
  // disagrees anyway. Balances are read from the raw wallet addresses, which
  // none of this changes.
  function resilient(signer) {
    const managed = new ethers.NonceManager(signer);
    const contract = new ethers.Contract(address, abi, managed);
    return new Proxy(contract, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== 'function' || typeof prop !== 'string') return original;
        return async (...args) => {
          for (let attempt = 1; ; attempt++) {
            try {
              return await original.apply(target, args);
            } catch (err) {
              // NonceManager increments optimistically, so a send that fails
              // -- including the deliberate reverts in the guard tests --
              // leaves a gap. The next transaction would then wait forever
              // on a nonce that never arrives. Re-sync after every failure,
              // not just the ones worth retrying.
              managed.reset();

              const message = String(err?.message ?? '');
              const nonceClash = err?.code === 'NONCE_EXPIRED'
                || message.includes('nonce too low')
                || message.includes('nonce has already been used')
                || message.includes('replacement transaction underpriced');
              if (!nonceClash || attempt >= 5) throw err;
              await new Promise(r => setTimeout(r, 1500 * attempt));
            }
          }
        };
      },
    });
  }

  const asAgent = resilient(agent);
  const asArbiter = resilient(arbiter);
  const asDisputer = resilient(disputer);

  console.log('contract:', address);
  console.log('agent:   ', agent.address);
  console.log('arbiter: ', arbiter.address, '(on-chain:', await asAgent.arbiter() + ')');
  console.log('disputer:', disputer.address);
  console.log('bond:', ethers.formatEther(BOND), 'ETH   liveness:', livenessSeconds, 's   arbiter timeout:', arbiterTimeoutSeconds, 's   payout:', ethers.formatEther(PAYOUT), 'ETH');

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

    tx = await asDisputer.dispute(id, { value: BOND });
    const disputeReceipt = await tx.wait();
    const disputeCost = await txCost(provider, tx.hash);
    a = await asAgent.getAssertion(id);
    check('assertion is Disputed after dispute', Number(a.state) === 2);
    check('disputer recorded', a.disputer.toLowerCase() === disputer.address.toLowerCase());

    // Balance movements are measured across the single block each transfer
    // lands in. A whole-test delta would have to model every fee the account
    // paid in between, which is exactly the kind of bookkeeping that makes a
    // financial assertion fragile rather than exact.
    const disputerStakeDelta =
      (await provider.getBalance(disputer.address, disputeReceipt.blockNumber))
      - (await provider.getBalance(disputer.address, disputeReceipt.blockNumber - 1));

    const agentBefore = await provider.getBalance(agent.address);
    tx = await asArbiter.resolveDispute(id, true);
    const resolveReceipt = await tx.wait();

    const p = await asAgent.getPolicy(id);
    const beneficiaryBal = await provider.getBalance(beneficiary);
    const agentAfter = await provider.getBalance(agent.address);
    const disputerAtResolve =
      (await provider.getBalance(disputer.address, resolveReceipt.blockNumber))
      - (await provider.getBalance(disputer.address, resolveReceipt.blockNumber - 1));

    check('policy marked triggered', p.triggered === true);
    check('policy no longer active', p.active === false);
    check('beneficiary received full payout', beneficiaryBal === PAYOUT, ethers.formatEther(beneficiaryBal) + ' ETH');
    check('agent received own bond + disputer bond (2x bond)', agentAfter - agentBefore === BOND * 2n, '+' + ethers.formatEther(agentAfter - agentBefore) + ' ETH');
    check('disputer staked exactly one bond', -disputerStakeDelta - disputeCost === BOND, '-' + ethers.formatEther(-disputerStakeDelta - disputeCost) + ' ETH excluding their own gas');
    check('disputer got nothing back after losing', disputerAtResolve === 0n, ethers.formatEther(disputerAtResolve) + ' ETH at the resolve block');
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
    const resolveReceipt = await tx.wait();

    const p = await asAgent.getPolicy(id);
    const beneficiaryBal = await provider.getBalance(beneficiary);
    const agentAfter = await provider.getBalance(agent.address);

    // Measure the slashing payout at the block it happens in, rather than as
    // a whole-test balance delta. The disputer pays gas on their own
    // transactions, so a net-of-fees figure has to model every fee they paid;
    // a block-scoped delta on an address that sent nothing in that block is
    // the transfer itself, with no fee accounting to get wrong.
    const disputerAtResolve = await provider.getBalance(disputer.address, resolveReceipt.blockNumber);
    const disputerBeforeResolve = await provider.getBalance(disputer.address, resolveReceipt.blockNumber - 1);
    const paidOut = disputerAtResolve - disputerBeforeResolve;

    check('policy still active (not triggered)', p.active === true && p.triggered === false);
    check('beneficiary received NOTHING', beneficiaryBal === 0n);
    check('agent bond NOT returned (slashed)', agentAfter === agentBefore, 'delta ' + ethers.formatEther(agentAfter - agentBefore));
    // The disputer is paid both bonds -- their own back, plus the agent's.
    check('disputer paid exactly 2 bonds (own + the agent\'s slashed bond)', paidOut === BOND * 2n, ethers.formatEther(paidOut) + ' ETH received at the resolve block');
    check('net of their stake, the disputer gains exactly 1 bond', paidOut - BOND === BOND, '+' + ethers.formatEther(paidOut - BOND) + ' ETH');
    void disputeCost;

    // Cover has to survive being wrong once. A policy the agent asserted
    // wrongly is not spent -- the storm it was wrong about may still arrive
    // later -- so the assertion clears and the policy stays assertable,
    // rather than sitting funded but permanently unusable.
    const cleared = await asAgent.getAssertion(id);
    check('assertion cleared back to None after a slash', Number(cleared.state) === 0, `state=${Number(cleared.state)}`);

    const reassert = await asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9000, 9000, 're-assertion after an earlier one was ruled wrong', { value: BOND });
    await reassert.wait();
    check('policy can be asserted again after a slash', Number((await asAgent.getAssertion(id)).state) === 1);
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

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== TEST 5: the bond scales with the payout at stake ===');
  {
    // A flat bond means the incentive to be careful shrinks as the payout
    // grows. These two policies differ only in size, so the bond must too.
    const small = await createPolicy(asAgent, ethers.Wallet.createRandom().address, 'Cebu, Philippines');
    const bigPayout = ethers.parseEther('0.0001'); // 20x the standard test payout
    const btx = await asAgent.createPolicy(ethers.Wallet.createRandom().address, 'Taipei, Taiwan', { value: bigPayout });
    const breceipt = await btx.wait();
    const big = breceipt.logs
      .map(l => { try { return asAgent.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === 'PolicyCreated').args.policyId;

    const smallBond = await asAgent.requiredBond(small);
    const bigBond = await asAgent.requiredBond(big);
    const expectedBig = (bigPayout * BigInt(bondBps)) / 10000n;

    check('small policy takes the bond floor', smallBond === BigInt(minBondWei),
      ethers.formatEther(smallBond) + ' ETH');
    check('large policy bond scales with its payout', bigBond === expectedBig,
      ethers.formatEther(bigBond) + ' ETH on a ' + ethers.formatEther(bigPayout) + ' ETH payout');
    check('a larger payout demands a larger bond', bigBond > smallBond);

    await expectRevert('asserting with the old flat bond now reverts', () =>
      asAgent.assertTrigger(big, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'underfunded bond', { value: smallBond }));

    const otx = await asAgent.assertTrigger(big, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'correctly scaled bond', { value: bigBond });
    await otx.wait();
    check('asserting with the scaled bond succeeds', Number((await asAgent.getAssertion(big)).state) === 1);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n=== TEST 6: a dispute the arbiter never answers can be unwound ===');
  {
    const beneficiary = ethers.Wallet.createRandom().address;
    const id = await createPolicy(asAgent, beneficiary, 'Dhaka, Bangladesh');
    console.log('  policy', id.toString(), 'created');

    let tx = await asAgent.assertTrigger(id, FORECAST_HASH, ALERT_HASH, 9000, 9000, 'assertion that will be disputed and abandoned', { value: BOND });
    await tx.wait();
    tx = await asDisputer.dispute(id, { value: BOND });
    await tx.wait();
    check('assertion is Disputed', Number((await asAgent.getAssertion(id)).state) === 2);

    await expectRevert('cannot unwind before the arbiter timeout', () => asAgent.resolveStale(id));

    // The arbiter deliberately never rules here.
    console.log(`  waiting ${arbiterTimeoutSeconds}s for the arbiter timeout to pass...`);
    await new Promise(r => setTimeout(r, (arbiterTimeoutSeconds + 15) * 1000));

    const agentBefore = await provider.getBalance(agent.address);
    // Called by the disputer to show it is permissionless, not an agent power.
    const stx = await asDisputer.resolveStale(id);
    const sreceipt = await stx.wait();

    const agentAfter = await provider.getBalance(agent.address);
    const disputerRefund =
      (await provider.getBalance(disputer.address, sreceipt.blockNumber))
      - (await provider.getBalance(disputer.address, sreceipt.blockNumber - 1));
    const p = await asAgent.getPolicy(id);

    check('agent bond refunded in full', agentAfter - agentBefore === BOND, '+' + ethers.formatEther(agentAfter - agentBefore) + ' ETH');
    check('disputer bond refunded in full', disputerRefund + (await txCost(provider, stx.hash)) === BOND,
      '+' + ethers.formatEther(disputerRefund) + ' ETH net of their own gas');
    check('nobody was slashed for the arbiter going silent', true);
    check('beneficiary received nothing', (await provider.getBalance(beneficiary)) === 0n);
    check('policy still active and assertable again', p.active === true && p.triggered === false
      && Number((await asAgent.getAssertion(id)).state) === 0);
    check('unwinding was permissionless (called by the disputer)', true);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
