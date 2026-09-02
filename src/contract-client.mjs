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

const abi = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/StormPolicy.abi.json'), 'utf8'));
const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/deployment.json'), 'utf8'));
const { address } = deployment;

export const DEPLOY_BLOCK = deployment.blockNumber;

export function getContract() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const pk = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('TEST_WALLET_PRIVATE_KEY is not set (expected in .env or the environment)');
  const wallet = new ethers.Wallet(pk, provider);
  return { contract: new ethers.Contract(address, abi, wallet), wallet, provider };
}

export const CONTRACT_ADDRESS = address;
