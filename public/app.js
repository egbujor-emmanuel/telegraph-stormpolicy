const CONTRACT_ADDRESS = '0xFDB301bB77e82B5CB75D9768C79B4d3Af2D19424';
const CHAIN_ID_HEX = '0x14a34'; // 84532 Base Sepolia
const EXPLORER = 'https://sepolia.basescan.org';

const ABI = [
  'function createPolicy(address beneficiary, string location) payable returns (uint256)',
  'function getPolicy(uint256) view returns (tuple(address funder, address beneficiary, string location, uint256 payoutAmount, bool active, bool triggered, uint256 createdAt))',
  'function nextPolicyId() view returns (uint256)',
];

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
  if (!window.ethereum) {
    walletStatus.textContent = 'No injected wallet found. Install MetaMask to create a policy.';
    walletStatus.className = 'status-line err';
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
    walletStatus.textContent = `Connected: ${address.slice(0, 6)}...${address.slice(-4)}`;
    walletStatus.className = 'status-line ok';
    document.getElementById('cp-beneficiary').value = address;
    document.getElementById('create-btn').disabled = false;
    connectBtn.textContent = 'Connected';
  } catch (err) {
    walletStatus.textContent = 'Connection failed: ' + err.message;
    walletStatus.className = 'status-line err';
  }
});

// ── Assess (read-only, live) ────────────────────────────────────────────
document.getElementById('assess-btn').addEventListener('click', async () => {
  const btn = document.getElementById('assess-btn');
  const location = document.getElementById('assess-location').value.trim();
  const statusEl = document.getElementById('assess-status');
  const outEl = document.getElementById('assess-out');
  if (!location) { statusEl.textContent = 'Enter a location.'; statusEl.className = 'status-line err'; return; }
  btn.disabled = true;
  statusEl.textContent = 'Calling live Telegraph signals, paid via x402';
  statusEl.className = 'status-line loading';
  outEl.hidden = true;
  try {
    const res = await fetch('/api/assess', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'assess failed');
    statusEl.textContent = data.shouldTrigger ? 'Decision: would TRIGGER' : 'Decision: would HOLD';
    statusEl.className = 'status-line ' + (data.shouldTrigger ? 'ok' : '');
    outEl.textContent = JSON.stringify(data, null, 2);
    outEl.hidden = false;
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'status-line err';
  } finally {
    btn.disabled = false;
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

async function checkPolicy(id, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Checking...';
  try {
    const res = await fetch(`/api/check/${id}`, { method: 'POST' });
    const data = await res.json();
    if (data.triggered) {
      alert(`Policy ${id} triggered.\ntx: ${data.txHash}\n\n${data.reason}`);
    } else {
      alert(`Policy ${id}: holding.\n\n${data.reason}`);
    }
    loadPolicies();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function showEvidence(id) {
  const res = await fetch(`/api/policy/${id}/evidence`);
  const data = await res.json();
  if (!data.triggered) { alert('No evidence yet -- not triggered.'); return; }
  alert(
    `Policy ${id} evidence\n\n` +
    `tx: ${data.txHash}\nblock: ${data.blockNumber}\n\n` +
    `forecast confidence: ${data.forecastConfidencePct}%\n` +
    `alert confidence: ${data.alertConfidencePct}%\n\n` +
    `forecast signal hash: ${data.forecastSignalHash}\n` +
    `alert signal hash: ${data.alertSignalHash}\n\n` +
    `reason: ${data.reason}\n\n` +
    `View on explorer: ${EXPLORER}/tx/${data.txHash}`
  );
}

async function loadPolicies() {
  const res = await fetch('/api/policies');
  const data = await res.json();
  const container = document.getElementById('policy-cards');
  const empty = document.getElementById('empty');
  const policies = data.policies || [];

  animateCount(document.getElementById('stat-policies'), policies.length);
  animateCount(document.getElementById('stat-triggered'), policies.filter(p => p.triggered).length);

  if (policies.length === 0) {
    container.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  container.innerHTML = policies.map(p => {
    const action = p.active
      ? `<button class="btn btn-outline btn-sm" onclick="checkPolicy('${p.id}', this)">Check Now</button>`
      : p.triggered
        ? `<button class="btn btn-ghost btn-sm" onclick="showEvidence('${p.id}')">Evidence</button>`
        : '';
    return `
      <div class="policy-card">
        <div class="policy-main">
          <div class="policy-location">${p.location}</div>
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

window.checkPolicy = checkPolicy;
window.showEvidence = showEvidence;

loadPolicies();
setInterval(loadPolicies, 30000);
