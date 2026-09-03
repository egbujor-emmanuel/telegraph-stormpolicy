/// Opens the standing book of policies the monitor watches.
///
/// These are real, funded policies on real storm-exposed cities -- the
/// tropical-cyclone belt plus a few temperate-storm locations -- so the
/// scheduled sweep does genuine work on every run: two live Telegraph
/// intents per policy, corroborated and location-bound before anything is
/// asserted on-chain. Each one carries a real payout obligation; none of
/// them is a placeholder.
import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

const abi = JSON.parse(fs.readFileSync('./build/StormPolicyBonded.abi.json', 'utf8'));
const deployment = JSON.parse(fs.readFileSync('./build/deployment-bonded.json', 'utf8'));

const PAYOUT = ethers.parseEther('0.000002');

// Chosen because they actually sit in cyclone/typhoon/hurricane paths or
// take regular severe-weather hits -- the places a parametric storm cover
// would genuinely be written for.
const COVERAGE = [
  'Manila, Philippines',
  'Cebu, Philippines',
  'Jakarta, Indonesia',
  'Ho Chi Minh City, Vietnam',
  'Dhaka, Bangladesh',
  'Kolkata, India',
  'Mumbai, India',
  'Taipei, Taiwan',
  'Okinawa, Japan',
  'Hong Kong',
  'Miami, Florida',
  'New Orleans, Louisiana',
  'Darwin, Australia',
  'Reykjavik, Iceland',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = new ethers.Wallet(process.env.TEST_WALLET_PRIVATE_KEY, provider);
// Local nonce tracking: this public RPC's pending count lags behind rapid
// successive sends, which otherwise reuses a nonce partway through the book.
const contract = new ethers.Contract(deployment.address, abi, new ethers.NonceManager(wallet));

const balance = await provider.getBalance(wallet.address);
const needed = PAYOUT * BigInt(COVERAGE.length);
console.log(`contract: ${deployment.address}`);
console.log(`balance:  ${ethers.formatEther(balance)} ETH`);
console.log(`funding:  ${ethers.formatEther(needed)} ETH across ${COVERAGE.length} policies\n`);
if (balance < needed * 2n) {
  console.error('Balance too thin to fund the book plus gas. Aborting.');
  process.exit(1);
}

// Don't re-open cover that is already standing for a location.
const existing = new Set();
const next = Number(await contract.nextPolicyId());
for (let i = 0; i < next; i++) {
  const p = await contract.getPolicy(i);
  if (p.active && !p.triggered) existing.add(p.location);
}
if (existing.size) console.log(`already covered: ${[...existing].join(', ')}\n`);

const opened = [];
for (const location of COVERAGE) {
  if (existing.has(location)) {
    console.log(`skip  ${location} -- already covered`);
    continue;
  }
  process.stdout.write(`open  ${location} ... `);
  // The public RPC's nonce accounting lags recent sends, and anything else
  // signing from this account at the same time will collide. Re-sync and
  // retry rather than abandoning a half-written book.
  let receipt;
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = await contract.createPolicy(wallet.address, location, { value: PAYOUT });
      receipt = await tx.wait();
      break;
    } catch (err) {
      const m = String(err?.message ?? '');
      const nonceClash = err?.code === 'NONCE_EXPIRED'
        || m.includes('nonce too low')
        || m.includes('nonce has already been used')
        || m.includes('replacement transaction underpriced');
      if (!nonceClash || attempt >= 5) throw err;
      contract.runner.reset();
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  const log = receipt.logs
    .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find(l => l && l.name === 'PolicyCreated');
  const id = log.args.policyId.toString();
  opened.push({ id, location });
  console.log(`policy #${id}`);
}

console.log(`\nOpened ${opened.length} new policies.`);
const total = Number(await contract.nextPolicyId());
let active = 0;
for (let i = 0; i < total; i++) {
  const p = await contract.getPolicy(i);
  const a = await contract.getAssertion(i);
  if (p.active && !p.triggered && Number(a.state) === 0) active++;
}
console.log(`${active} policies are now assertable -- ${active * 2} live Telegraph calls per sweep.`);
