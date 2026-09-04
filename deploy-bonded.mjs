import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { ethers } from 'ethers';

const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const CHAIN_ID = 84532;

// Demo-scoped liveness: long enough to be a real window, short enough to
// actually watch resolve in one sitting. Contract comments document that
// production would likely use something closer to UMA's 2h-2day default,
// scaled to how much value a single assertion moves.
const LIVENESS_SECONDS = 180;
// A dispute nobody arbitrates can be unwound after this, returning both
// bonds. Kept short here so the behaviour is demonstrable; a production
// deployment would allow an arbiter days, not minutes.
const ARBITER_TIMEOUT_SECONDS = 240;
// Bond floor, plus the share of each payout the agent must stake behind a
// claim. 20% keeps the agent's exposure proportional to the money it moves.
const MIN_BOND_WEI = ethers.parseEther('0.000003');
const BOND_BPS = 2000n;

const abi = JSON.parse(fs.readFileSync('./build/StormPolicyBonded.abi.json', 'utf8'));
const bytecode = '0x' + fs.readFileSync('./build/StormPolicyBonded.bytecode.txt', 'utf8').trim();

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const pk = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('TEST_WALLET_PRIVATE_KEY is not set (expected in .env)');
  const wallet = new ethers.Wallet(pk, provider);

  // Fresh, ephemeral testnet-only wallets for the arbiter role and the
  // disputer role in later tests -- kept separate from the agent so the
  // bond/slash flow moves value between genuinely distinct parties rather
  // than the agent effectively disputing and arbitrating itself.
  const arbiterWallet = ethers.Wallet.createRandom();
  const disputerWallet = ethers.Wallet.createRandom();

  console.log('deployer / agent address:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('agent balance (ETH):', ethers.formatEther(bal));
  console.log('arbiter address (fresh, ephemeral):', arbiterWallet.address);
  console.log('disputer address (fresh, ephemeral):', disputerWallet.address);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log('\ndeploying StormPolicyBonded...');
  const contract = await factory.deploy(
    wallet.address,
    arbiterWallet.address,
    MIN_BOND_WEI,
    BOND_BPS,
    LIVENESS_SECONDS,
    ARBITER_TIMEOUT_SECONDS,
  );
  const deployTx = contract.deploymentTransaction();
  console.log('deploy tx hash:', deployTx.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('StormPolicyBonded deployed at:', address);

  const receipt = await provider.getTransactionReceipt(deployTx.hash);
  console.log('block:', receipt.blockNumber, 'gas used:', receipt.gasUsed.toString());

  // Fund the arbiter and disputer wallets with just enough Base Sepolia
  // ETH for their own gas (disputer also needs the bond amount itself).
  console.log('\nfunding arbiter and disputer wallets for gas...');
  let tx = await wallet.sendTransaction({ to: arbiterWallet.address, value: ethers.parseEther('0.00005') });
  await tx.wait();
  tx = await wallet.sendTransaction({ to: disputerWallet.address, value: ethers.parseEther('0.00005') + MIN_BOND_WEI * 6n });
  await tx.wait();
  console.log('funded.');

  fs.writeFileSync('./build/deployment-bonded.json', JSON.stringify({
    address,
    agent: wallet.address,
    arbiter: arbiterWallet.address,
    disputer: disputerWallet.address,
    minBondWei: MIN_BOND_WEI.toString(),
    bondBps: Number(BOND_BPS),
    arbiterTimeoutSeconds: ARBITER_TIMEOUT_SECONDS,
    livenessSeconds: LIVENESS_SECONDS,
    deployTxHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    chainId: CHAIN_ID,
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log('saved public deployment info to ./build/deployment-bonded.json');

  // Keys for the ephemeral test roles go in a separate gitignored file so
  // the deployment artifact itself stays safe to commit.
  fs.writeFileSync('./.bonded-test-keys.json', JSON.stringify({
    arbiterPrivateKey: arbiterWallet.privateKey,
    disputerPrivateKey: disputerWallet.privateKey,
  }, null, 2));
  console.log('saved ephemeral test-role keys to ./.bonded-test-keys.json (gitignored)');
})().catch(e => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
