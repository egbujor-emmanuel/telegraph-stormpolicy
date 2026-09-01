import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { getContract, CONTRACT_ADDRESS, DEPLOY_BLOCK } from '../src/contract-client.mjs';
import { assessStormRisk } from '../src/decision-engine.mjs';
import { checkAndTriggerPolicy, checkAllPolicies } from '../src/monitor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 10 * 60 * 1000); // 10 min default

function log(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Read-only: list all policies ────────────────────────────────────────
app.get('/api/policies', async (req, res) => {
  try {
    const { contract } = getContract();
    const next = await contract.nextPolicyId();
    const policies = [];
    for (let id = 0n; id < next; id++) {
      const p = await contract.getPolicy(id);
      policies.push({
        id: id.toString(),
        funder: p.funder,
        beneficiary: p.beneficiary,
        location: p.location,
        payoutEth: ethers.formatEther(p.payoutAmount),
        active: p.active,
        triggered: p.triggered,
        createdAt: new Date(Number(p.createdAt) * 1000).toISOString(),
      });
    }
    res.json({ contract: CONTRACT_ADDRESS, policies });
  } catch (err) {
    log('policies_error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Read-only: evidence for a triggered policy, pulled from the event log ──
app.get('/api/policy/:id/evidence', async (req, res) => {
  try {
    const { contract, provider } = getContract();
    const id = BigInt(req.params.id);
    const filter = contract.filters.PolicyTriggered(id);
    // The RPC caps eth_getLogs at a 50,000-block range -- search from the
    // contract's own deployment block, not from genesis.
    const events = await contract.queryFilter(filter, DEPLOY_BLOCK, 'latest');
    if (events.length === 0) {
      return res.json({ triggered: false });
    }
    const ev = events[0];
    const receipt = await provider.getTransactionReceipt(ev.transactionHash);
    res.json({
      triggered: true,
      txHash: ev.transactionHash,
      blockNumber: ev.blockNumber,
      forecastSignalHash: ev.args.forecastSignalHash,
      alertSignalHash: ev.args.alertSignalHash,
      forecastConfidencePct: Number(ev.args.forecastConfidenceBps) / 100,
      alertConfidencePct: Number(ev.args.alertConfidenceBps) / 100,
      reason: ev.args.reason,
      payoutEth: ethers.formatEther(ev.args.payoutAmount),
      gasUsed: receipt.gasUsed.toString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Read-only: preview a corroboration decision without touching the contract ──
app.post('/api/assess', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location || typeof location !== 'string') {
      return res.status(400).json({ error: 'location (string) is required' });
    }
    log('assess_start', { location });
    const decision = await assessStormRisk(location);
    log('assess_complete', { location, shouldTrigger: decision.shouldTrigger });
    res.json({
      location,
      shouldTrigger: decision.shouldTrigger,
      reason: decision.reason,
      forecastSignalHash: decision.forecastSignalHash,
      alertSignalHash: decision.alertSignalHash,
      forecast: decision.forecast,
      alert: decision.alert,
    });
  } catch (err) {
    log('assess_error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Action: check one policy now and trigger if warranted (uses agent key) ──
app.post('/api/check/:id', async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    log('check_start', { policyId: id.toString() });
    const result = await checkAndTriggerPolicy(id);
    log('check_complete', { policyId: id.toString(), triggered: !!result.triggered });
    res.json({
      policyId: result.policyId?.toString?.() ?? req.params.id,
      triggered: !!result.triggered,
      skipped: !!result.skipped,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      reason: result.decision?.reason || result.reason,
    });
  } catch (err) {
    log('check_error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', contract: CONTRACT_ADDRESS, sweepIntervalMs: SWEEP_INTERVAL_MS, uptimeMs: process.uptime() * 1000 });
});

app.listen(PORT, () => {
  log('server_started', { port: PORT, contract: CONTRACT_ADDRESS });
});

// ── Persistence: sweep all active policies on an interval ─────────────────
async function sweepLoop() {
  try {
    log('sweep_start');
    const results = await checkAllPolicies();
    log('sweep_complete', { checked: results.length, triggered: results.filter(r => r.triggered).length });
  } catch (err) {
    log('sweep_error', { error: err.message });
  }
}
setInterval(sweepLoop, SWEEP_INTERVAL_MS).unref();
log('sweep_scheduled', { intervalMs: SWEEP_INTERVAL_MS });
