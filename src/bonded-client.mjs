import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ethers } from 'ethers';
import { config } from 'dotenv';
config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

const abi = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/StormPolicyBonded.abi.json'), 'utf8'));
const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/deployment-bonded.json'), 'utf8'));

export const BONDED_ADDRESS = deployment.address;
export const BONDED_DEPLOY_BLOCK = deployment.blockNumber;
export const AGENT_BOND_WEI = BigInt(deployment.agentBondWei);
export const LIVENESS_SECONDS = deployment.livenessSeconds;
export const ARBITER_ADDRESS = deployment.arbiter;

/// Assertion.state values, matching the contract's enum ordering.
export const AssertionState = {
  None: 0,
  Pending: 1,
  Disputed: 2,
  Resolved: 3,
};

export function getBondedContract() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const pk = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('TEST_WALLET_PRIVATE_KEY is not set (expected in .env or the environment)');
  const wallet = new ethers.Wallet(pk, provider);
  return { contract: new ethers.Contract(BONDED_ADDRESS, abi, wallet), wallet, provider };
}

/// Read-only handle -- no key needed, for viewing state.
export function getBondedReader() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  return { contract: new ethers.Contract(BONDED_ADDRESS, abi, provider), provider };
}
