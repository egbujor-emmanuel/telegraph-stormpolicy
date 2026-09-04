// The bonded contract carries the standing book of cover and is what the
// scheduled agent actually sweeps, so it is what this page reads.
const CONTRACT_ADDRESS = '0xECb611641342A0EF514B1D4e425b51dF0bf4f9bE';
const CHAIN_ID_HEX = '0x14a34'; // 84532 Base Sepolia
const CHAIN_ID = 84532;
const RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const DEPLOY_BLOCK = 46362557;
// The agent that writes the standing book of cover, and the beneficiary it
// names on those policies.
const AGENT_ADDRESS = '0x98eC4d722048EB7cf6386c8F5C9757e9B0143F8c';
const EXPLORER = 'https://sepolia.basescan.org';

const ABI = [
  'function createPolicy(address beneficiary, string location) payable returns (uint256)',
  'function getPolicy(uint256) view returns (tuple(address funder, address beneficiary, string location, uint256 payoutAmount, bool active, bool triggered, uint256 createdAt))',
  'function getAssertion(uint256) view returns (tuple(uint8 state, uint256 bondAmount, uint256 disputeBond, address disputer, uint256 livenessEnds, uint256 disputedAt, bytes32 forecastSignalHash, bytes32 alertSignalHash, uint256 forecastConfidenceBps, uint256 alertConfidenceBps, string reason))',
  'function requiredBond(uint256) view returns (uint256)',
  'function nextPolicyId() view returns (uint256)',
  'event PolicyTriggered(uint256 indexed policyId, bytes32 forecastSignalHash, bytes32 alertSignalHash, uint256 forecastConfidenceBps, uint256 alertConfidenceBps, string reason, uint256 payoutAmount)',
];

// Everything below reads directly from the chain via a public RPC -- this
// page has no backend. The agent's key that trusts triggerPayout() lives
// only in the GitHub Actions monitor, never here.
const readProvider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);

// eth_getLogs on this RPC caps ranges at 50,000 blocks, so page through it.
async function queryFilterChunked(filter, fromBlock, toBlock, chunkSize = 45000) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    logs.push(...await readContract.queryFilter(filter, start, end));
  }
  return logs;
}

for (const id of ['nav-contract', 'footer-contract']) {
  const el = document.getElementById(id);
  el.href = `${EXPLORER}/address/${CONTRACT_ADDRESS}`;
}

// ── Motion: scroll-reveal for panels ─────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      revealObserver.unobserve(entry.target);
    }
  }
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

// ── Motion: count-up for stat numbers ────────────────────────────────────
function animateCount(el, to) {
  const suffix = el.dataset.suffix || '';
  const from = Number(el.textContent) || 0;
  if (from === to) { el.textContent = to + suffix; return; }
  const duration = 900;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const value = Math.round(from + (to - from) * eased);
    el.textContent = value + suffix;
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
document.querySelectorAll('[data-count]').forEach((el) => {
  const target = Number(el.dataset.count);
  if (!el.id) animateCount(el, target); // static stats (signals, evidence%) animate once on load
});

let signer = null;
let browserProvider = null;

// ── Wallet connect ──────────────────────────────────────────────────────
document.getElementById('connect-btn').addEventListener('click', async () => {
  const walletStatus = document.getElementById('wallet-status');
  const connectBtn = document.getElementById('connect-btn');

  // The button sits in the nav but its status line sits in the form well
  // below the fold, so a failure here used to be invisible: you clicked and
  // nothing appeared to happen. Always bring the message into view.
  const report = (msg, kind) => {
    walletStatus.textContent = msg;
    walletStatus.className = 'status-line ' + kind;
    document.getElementById('create').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (!window.ethereum) {
    connectBtn.textContent = 'No wallet found';
    setTimeout(() => { connectBtn.textContent = 'Connect Wallet'; }, 4000);
    report('No browser wallet detected. Install MetaMask (or another injected wallet), then reload this page to create a policy. Everything else on this page works without one.', 'err');
    return;
  }
  try {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (switchErr) {
      if (switchErr.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX,
            chainName: 'Base Sepolia',
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://base-sepolia-rpc.publicnode.com'],
            blockExplorerUrls: [EXPLORER],
          }],
        });
      }
    }
    browserProvider = new ethers.BrowserProvider(window.ethereum);
    signer = await browserProvider.getSigner();
    const address = await signer.getAddress();
    document.getElementById('cp-beneficiary').value = address;
    document.getElementById('create-btn').disabled = false;
    connectBtn.textContent = 'Connected';
    report(`Connected: ${address.slice(0, 6)}...${address.slice(-4)} on Base Sepolia. Fill in a location and payout below.`, 'ok');
  } catch (err) {
    // Rejecting the wallet prompt is a normal thing to do, not a failure
    // worth shouting about.
    const rejected = err?.code === 4001 || /user rejected|denied/i.test(String(err?.message));
    report(rejected
      ? 'Connection cancelled in your wallet.'
      : 'Connection failed: ' + (err?.shortMessage || err?.message || String(err)), 'err');
  }
});

// ── Create policy (direct on-chain, user's own wallet) ──────────────────
document.getElementById('create-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('create-status');
  const beneficiary = document.getElementById('cp-beneficiary').value.trim();
  const location = document.getElementById('cp-location').value.trim();
  const payoutEth = document.getElementById('cp-payout').value.trim();
  if (!signer) { statusEl.textContent = 'Connect a wallet first.'; statusEl.className = 'status-line err'; return; }
  if (!beneficiary || !location || !payoutEth) { statusEl.textContent = 'All fields required.'; statusEl.className = 'status-line err'; return; }
  try {
    statusEl.textContent = 'Confirm in your wallet';
    statusEl.className = 'status-line loading';
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const tx = await contract.createPolicy(beneficiary, location, { value: ethers.parseEther(payoutEth) });
    statusEl.textContent = `Submitted ${tx.hash.slice(0, 10)}... waiting for confirmation.`;
    const receipt = await tx.wait();
    statusEl.textContent = `Confirmed in block ${receipt.blockNumber}.`;
    statusEl.className = 'status-line ok';
    document.getElementById('cp-location').value = '';
    document.getElementById('cp-payout').value = '';
    loadPolicies();
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.shortMessage || err.message);
    statusEl.className = 'status-line err';
  }
});

// ── Policy cards ─────────────────────────────────────────────────────────
function statusBadge(p) {
  if (p.triggered) return '<span class="badge triggered">Triggered</span>';
  if (p.active) return '<span class="badge active">Active</span>';
  return '<span class="badge cancelled">Cancelled</span>';
}

async function showEvidence(id) {
  const logs = await queryFilterChunked(readContract.filters.PolicyTriggered(id), DEPLOY_BLOCK, await readProvider.getBlockNumber());
  if (logs.length === 0) { alert('No evidence yet -- not triggered.'); return; }
  const log = logs[0];
  const a = log.args;
  alert(
    `Policy ${id} evidence\n\n` +
    `tx: ${log.transactionHash}\nblock: ${log.blockNumber}\n\n` +
    `forecast confidence: ${Number(a.forecastConfidenceBps) / 100}%\n` +
    `alert confidence: ${Number(a.alertConfidenceBps) / 100}%\n\n` +
    `forecast signal hash: ${a.forecastSignalHash}\n` +
    `alert signal hash: ${a.alertSignalHash}\n\n` +
    `reason: ${a.reason}\n\n` +
    `View on explorer: ${EXPLORER}/tx/${log.transactionHash}`
  );
}

async function loadPolicies() {
  const container = document.getElementById('policy-cards');
  const empty = document.getElementById('empty');

  const next = Number(await readContract.nextPolicyId());
  const policies = await Promise.all(
    Array.from({ length: next }, (_, id) => id).map(async (id) => {
      const [p, a] = await Promise.all([readContract.getPolicy(id), readContract.getAssertion(id)]);
      return {
        id,
        beneficiary: p.beneficiary,
        location: p.location,
        payoutEth: ethers.formatEther(p.payoutAmount),
        active: p.active,
        triggered: p.triggered,
        assertionState: Number(a.state), // 0 none, 1 pending, 2 disputed, 3 resolved
        // The standing book is written to the agent's own address; the
        // contract test suite pays random throwaway addresses. Labelling the
        // difference is more useful than hiding the test rows, and both are
        // equally real on-chain.
        fromTestSuite: p.beneficiary.toLowerCase() !== AGENT_ADDRESS.toLowerCase(),
      };
    })
  );

  const covered = policies.filter(p => p.active && !p.triggered);
  // Each policy under cover costs two live Telegraph calls per sweep: one
  // WEATHER_FORECAST and one STORM_ALERT, both auto-routed and paid.
  const assertable = covered.filter(p => p.assertionState === 0).length;

  animateCount(document.getElementById('stat-policies'), covered.length);
  animateCount(document.getElementById('stat-cities'), new Set(covered.map(p => p.location)).size);
  animateCount(document.getElementById('stat-triggered'), policies.filter(p => p.triggered).length);
  animateCount(document.getElementById('stat-calls'), assertable * 2);

  if (policies.length === 0) {
    container.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  // Standing cover first, and within it the decisions that actually fired --
  // so the first thing a visitor opens is a real trigger on live signals
  // rather than a contract-test row.
  const ordered = [...policies].sort((a, b) => {
    if (a.fromTestSuite !== b.fromTestSuite) return a.fromTestSuite ? 1 : -1;
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    return b.id - a.id;
  });

  container.innerHTML = ordered.map(p => {
    const action = p.triggered
      ? `<button class="btn btn-ghost btn-sm" onclick="showEvidence('${p.id}')">Evidence</button>`
      : '';
    const origin = p.fromTestSuite ? '<span class="tag-test">contract test</span>' : '';
    return `
      <div class="policy-card">
        <div class="policy-main">
          <div class="policy-location">${p.location} ${origin}</div>
          <div class="policy-sub">#${p.id} &middot; ${p.payoutEth} ETH &middot; ${p.beneficiary.slice(0,6)}...${p.beneficiary.slice(-4)}</div>
        </div>
        <div class="policy-right">
          ${statusBadge(p)}
          ${action}
        </div>
      </div>
    `;
  }).join('');
}

window.showEvidence = showEvidence;

loadPolicies();
setInterval(loadPolicies, 30000);
