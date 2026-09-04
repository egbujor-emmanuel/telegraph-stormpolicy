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
let activeProvider = null;

// ── Wallet discovery (EIP-6963) ─────────────────────────────────────────
// Wallets used to fight over the single window.ethereum slot, so whichever
// extension loaded last answered for the page -- which is how a request can
// be declined by a wallet you never meant to use, without a prompt. EIP-6963
// lets every installed wallet announce itself instead, so any of them can be
// used and the choice is the user's rather than a race.
const discoveredWallets = new Map();
window.addEventListener('eip6963:announceProvider', (event) => {
  const { info, provider } = event.detail;
  discoveredWallets.set(info.uuid, { info, provider });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

/// Every wallet available to the page, newest discovery standard first and
/// falling back to the legacy injected object for wallets that predate it.
function availableWallets() {
  if (discoveredWallets.size > 0) return [...discoveredWallets.values()];
  const legacy = Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : null;
  if (legacy) {
    return legacy.map((provider, i) => ({
      info: { name: provider.isMetaMask ? 'MetaMask' : provider.isCoinbaseWallet ? 'Coinbase Wallet' : `Wallet ${i + 1}`, uuid: 'legacy-' + i },
      provider,
    }));
  }
  if (window.ethereum) return [{ info: { name: 'Browser wallet', uuid: 'legacy' }, provider: window.ethereum }];
  return [];
}

// ── Wallet connect (modal) ──────────────────────────────────────────────
const walletModal = document.getElementById('wallet-modal');
const walletList = document.getElementById('wallet-list');
const walletStatusEl = document.getElementById('wallet-status');
const walletModalSub = document.getElementById('wallet-modal-sub');
const connectBtn = document.getElementById('connect-btn');

function walletReport(msg, kind) {
  walletStatusEl.textContent = msg;
  walletStatusEl.className = 'status-line ' + kind;
}

function openWalletModal() {
  const wallets = availableWallets();
  walletReport('', '');
  walletList.innerHTML = '';

  if (wallets.length === 0) {
    walletModalSub.textContent = 'No wallet extension detected in this browser.';
    walletList.innerHTML =
      '<p class="wallet-none">Any EVM wallet works here — '
      + '<a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a>, '
      + '<a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a>, '
      + 'Coinbase Wallet, Brave, or Frame. Install one and reload this page.<br><br>'
      + 'A wallet is only needed to create your own policy — the live stats, the covered cities and the on-chain evidence above all work without one.</p>';
  } else {
    walletModalSub.textContent = wallets.length > 1
      ? 'Several wallets are available. Pick the one you want to use.'
      : 'Only needed to create your own policy. Everything else on this page works without one.';
    for (const wallet of wallets) {
      const btn = document.createElement('button');
      btn.className = 'wallet-option';
      btn.innerHTML = (wallet.info.icon ? `<img src="${wallet.info.icon}" alt="" />` : '')
        + `<span>${wallet.info.name}</span>`;
      btn.addEventListener('click', () => connectWith(wallet));
      walletList.appendChild(btn);
    }
  }
  walletModal.hidden = false;
}

function closeWalletModal() {
  walletModal.hidden = true;
}

connectBtn.addEventListener('click', () => {
  // Already connected? Reopening should let the account be changed, not
  // silently keep the one the wallet happened to hand back first.
  if (activeProvider) {
    const wallets = availableWallets();
    const current = wallets.find(w => w.provider === activeProvider) ?? wallets[0];
    if (current) { walletModal.hidden = false; connectWith(current); return; }
  }
  openWalletModal();
});
document.getElementById('wallet-modal-close').addEventListener('click', closeWalletModal);
walletModal.addEventListener('click', (e) => { if (e.target === walletModal) closeWalletModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !walletModal.hidden) closeWalletModal(); });

/// Lets the user choose which account to use, with each one's balance
/// shown -- a wallet holds several and the first one it hands back is
/// often not the funded one.
function chooseAccount(accounts, balances) {
  if (accounts.length === 1) return Promise.resolve(accounts[0]);
  return new Promise((resolve) => {
    walletModalSub.textContent = 'Choose the account to use.';
    walletList.innerHTML = '';
    accounts.forEach((address, i) => {
      const eth = Number(ethers.formatEther(balances[i]));
      const btn = document.createElement('button');
      btn.className = 'wallet-option';
      btn.innerHTML = `<span class="acct-addr">${address.slice(0, 6)}…${address.slice(-4)}</span>`
        + `<span class="acct-bal${eth > 0 ? ' funded' : ''}">${eth > 0 ? eth.toFixed(6) + ' ETH' : 'no funds'}</span>`;
      btn.addEventListener('click', () => resolve(address));
      walletList.appendChild(btn);
    });
  });
}

/// Re-opens the wallet's own account chooser, so accounts the page was
/// never granted can be added without disconnecting first.
async function requestDifferentAccount(provider) {
  try {
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    return true;
  } catch (err) {
    if (err?.code === 4001) return false;
    throw err;
  }
}

async function connectWith({ info, provider }) {
  const walletName = info.name;
  walletReport(`Waiting for ${walletName}… check the extension for a prompt.`, 'loading');
  try {
    let accounts = await provider.request({ method: 'eth_requestAccounts' });

    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (switchErr) {
      if (switchErr.code === 4902) {
        await provider.request({
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

    browserProvider = new ethers.BrowserProvider(provider);
    activeProvider = provider;

    // Balances come from the public RPC rather than the wallet, so they are
    // right even if the wallet is still catching up on the network switch.
    walletReport('Reading account balances…', 'loading');
    let balances = await Promise.all(accounts.map(a => readProvider.getBalance(a).catch(() => 0n)));

    const address = await chooseAccount(accounts, balances);
    signer = await browserProvider.getSigner(address);

    const balance = balances[accounts.indexOf(address)] ?? 0n;
    document.getElementById('cp-beneficiary').value = address;
    const createBtn = document.getElementById('create-btn');
    createBtn.disabled = false;
    createBtn.textContent = 'Create Policy';
    connectBtn.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;

    if (balance === 0n) {
      // Connect anyway. Refusing to proceed turned an empty account into a
      // dead end, when the fix might be a faucet, a different account, or
      // simply looking around -- none of which need the page to say no.
      walletModalSub.innerHTML = 'Connected, but this account holds no Base Sepolia ETH. '
        + 'Creating a policy needs some, for the escrow and for gas.';
      walletList.innerHTML =
        '<button class="wallet-option" id="switch-acct"><span>Use a different account</span></button>'
        + '<a class="wallet-option" href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noopener"><span>Get test ETH — Alchemy faucet</span></a>'
        + '<a class="wallet-option" href="https://faucet.quicknode.com/base/sepolia" target="_blank" rel="noopener"><span>Get test ETH — QuickNode faucet</span></a>'
        + '<button class="wallet-option" id="dismiss-acct"><span>Continue without funding</span></button>';

      document.getElementById('switch-acct').addEventListener('click', async () => {
        walletReport('Look for the account prompt in your wallet extension…', 'loading');
        try {
          const granted = await requestDifferentAccount(provider);
          if (granted) return connectWith({ info, provider });
          walletReport('No change made. You can also switch account inside the wallet extension itself — the page follows whatever it selects.', '');
        } catch (permErr) {
          walletReport(`This wallet would not reopen its account list (${permErr?.code ?? 'error'}). Switch account inside the extension instead — the page follows it.`, 'err');
        }
      });
      document.getElementById('dismiss-acct').addEventListener('click', closeWalletModal);

      walletReport('Connected. Everything on the page works; only creating a policy needs funds.', '');
      return;
    }

    walletReport(`Connected with ${walletName} — ${Number(ethers.formatEther(balance)).toFixed(6)} ETH.`, 'ok');
    setTimeout(() => {
      closeWalletModal();
      document.getElementById('create').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 800);
  } catch (err) {
    const code = err?.code;
    const detail = err?.shortMessage || err?.message || String(err);

    // A wallet can return 4001 without ever showing a prompt -- locked, or
    // answering for a page the user never pointed it at -- so name the
    // wallet and show the code rather than asserting a cause.
    let msg;
    if (code === -32002) {
      msg = `${walletName} already has a pending request. Open the extension, approve or dismiss it, then try again.`;
    } else if (code === 4001) {
      msg = `${walletName} declined. If no prompt appeared it is probably locked — open the extension, unlock it, and try again.`;
    } else {
      msg = `${walletName} failed to connect: ${detail}`;
    }
    walletReport(`${msg}${code !== undefined ? ` [code ${code}]` : ''}`, 'err');
    console.error('[wallet] connect failed', { wallet: walletName, code, detail });
  }
}

// ── Payout presets ──────────────────────────────────────────────────────
const payoutInput = document.getElementById('cp-payout');
document.querySelectorAll('#payout-presets .preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    payoutInput.value = btn.dataset.amount;
    document.querySelectorAll('#payout-presets .preset').forEach(b => b.classList.toggle('on', b === btn));
  });
});


// ── Create policy (direct on-chain, user's own wallet) ──────────────────
document.getElementById('create-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('create-status');
  const beneficiary = document.getElementById('cp-beneficiary').value.trim();
  const location = document.getElementById('cp-location').value.trim();
  const payoutEth = document.getElementById('cp-payout').value.trim();

  const fail = (msg) => { statusEl.textContent = msg; statusEl.className = 'status-line err'; };

  if (!signer) return fail('Connect a wallet first.');
  if (!location) return fail('Enter the location you want covered.');
  if (!payoutEth) return fail('Enter an amount to escrow, or pick one of the presets.');
  if (!beneficiary) return fail('Enter the address that should be paid.');
  if (!ethers.isAddress(beneficiary)) return fail('That beneficiary is not a valid address. It should look like 0x followed by 40 characters.');

  let value;
  try {
    value = ethers.parseEther(payoutEth);
  } catch {
    return fail(`"${payoutEth}" is not a valid ETH amount. Use a decimal like 0.000002.`);
  }
  if (value <= 0n) return fail('The amount to escrow has to be greater than zero.');

  try {
    statusEl.className = 'status-line loading';
    statusEl.textContent = 'Checking your wallet…';

    // The two things that actually go wrong here -- wrong network, or not
    // enough test ETH -- both surface from estimateGas as "missing revert
    // data", which explains nothing. Check them up front and say which it is.
    const net = await browserProvider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) {
      return fail(`Your wallet is on chain ${net.chainId}, but these policies live on Base Sepolia (${CHAIN_ID}). Switch network in your wallet and try again.`);
    }

    const from = await signer.getAddress();
    const balance = await browserProvider.getBalance(from);
    if (balance === 0n) {
      return fail('This account has no Base Sepolia ETH, so it cannot fund a policy or pay gas. Get some free test ETH from a Base Sepolia faucet, then try again.');
    }
    if (balance <= value) {
      return fail(`You are escrowing ${payoutEth} ETH but only hold ${Number(ethers.formatEther(balance)).toFixed(6)} ETH, and gas comes out of the same balance. Try a smaller amount.`);
    }

    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    statusEl.textContent = 'Confirm in your wallet…';
    const tx = await contract.createPolicy(beneficiary, location, { value });

    statusEl.textContent = `Submitted ${tx.hash.slice(0, 10)}… waiting for confirmation.`;
    const receipt = await tx.wait();
    statusEl.innerHTML = `Policy created in block ${receipt.blockNumber}. `
      + `<a href="${EXPLORER}/tx/${tx.hash}" target="_blank" rel="noopener">View transaction</a>. `
      + `The agent picks it up on its next sweep.`;
    statusEl.className = 'status-line ok';
    document.getElementById('cp-location').value = '';
    document.getElementById('cp-payout').value = '';
    loadPolicies();
  } catch (err) {
    const code = err?.code;
    const raw = err?.shortMessage || err?.message || String(err);

    let msg;
    if (code === 'ACTION_REJECTED' || err?.info?.error?.code === 4001) {
      msg = 'Transaction cancelled in your wallet.';
    } else if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(raw)) {
      msg = 'Not enough Base Sepolia ETH to cover the escrow plus gas. Top up from a faucet and try again.';
    } else if (/missing revert data|CALL_EXCEPTION/i.test(raw)) {
      // Reaching here means the checks above passed, so the estimate failed
      // for a reason the node did not explain.
      msg = 'The network could not simulate this transaction. Check that your wallet is on Base Sepolia and holds test ETH, then try again.';
    } else {
      msg = raw;
    }
    statusEl.textContent = 'Could not create the policy: ' + msg;
    statusEl.className = 'status-line err';
    console.error('[create] failed', { code, raw, err });
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

// ── Latest sweep, published by the scheduled agent ──────────────────────
// Read from a file the monitor commits after each run, so the page can show
// the agent's reasoning -- including the holds, which never reach the chain
// and are most of what it actually does.
async function loadLatestSweep() {
  const meta = document.getElementById('sweep-meta');
  const rows = document.getElementById('sweep-rows');
  try {
    const res = await fetch(`data/latest-sweep.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sweep = await res.json();

    const when = new Date(sweep.sweptAt);
    const minsAgo = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
    const ago = minsAgo < 60 ? `${minsAgo} min ago` : `${Math.round(minsAgo / 60)} h ago`;
    const bits = [`${ago}`, `${sweep.citiesAssessed} cities assessed`];
    if (sweep.signalsFetched) bits.push(`${sweep.signalsFetched} live Telegraph signals`);
    bits.push(`${sweep.triggered} triggered`);
    if (sweep.unavailable) bits.push(`${sweep.unavailable} awaiting signal`);
    meta.textContent = bits.join(' · ');

    if (!sweep.decisions?.length) {
      rows.innerHTML = '<div class="empty">No decisions in the last sweep.</div>';
      return;
    }
    rows.innerHTML = sweep.decisions.map(d => `
      <div class="sweep-row${d.triggered ? ' fired' : d.unavailable ? ' waiting' : ''}">
        <span class="sweep-verdict">${d.triggered ? 'Paid' : d.unavailable ? 'No signal' : 'Hold'}</span>
        <div class="sweep-body">
          <span class="sweep-city">${d.location ?? 'policy #' + d.policyId}</span>
          <span class="sweep-reason">${(d.reason ?? '').replace(/</g, '&lt;')}</span>
        </div>
      </div>`).join('');
  } catch {
    // The file only appears after the agent's first publishing run.
    meta.textContent = 'The next scheduled sweep will publish its decisions here.';
    rows.innerHTML = '';
  }
}

loadLatestSweep();
setInterval(loadLatestSweep, 120000);
