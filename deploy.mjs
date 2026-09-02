import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

const abi = JSON.parse(fs.readFileSync('./build/StormPolicy.abi.json', 'utf8'));
const bytecode = '0x' + fs.readFileSync('./build/StormPolicy.bytecode.txt', 'utf8').trim();

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const pk = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('TEST_WALLET_PRIVATE_KEY is not set (expected in .env)');
  const wallet = new ethers.Wallet(pk, provider);

  console.log('deployer / agent address:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('balance (ETH):', ethers.formatEther(bal));

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log('deploying StormPolicy (agent =', wallet.address, ')...');
  const contract = await factory.deploy(wallet.address);
  const deployTx = contract.deploymentTransaction();
  console.log('deploy tx hash:', deployTx.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('StormPolicy deployed at:', address);

  const receipt = await provider.getTransactionReceipt(deployTx.hash);
  console.log('block:', receipt.blockNumber, 'gas used:', receipt.gasUsed.toString());

  fs.writeFileSync('./build/deployment.json', JSON.stringify({
    address,
    agent: wallet.address,
    deployTxHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    chainId: CHAIN_ID,
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log('saved to ./build/deployment.json');
})().catch(e => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
