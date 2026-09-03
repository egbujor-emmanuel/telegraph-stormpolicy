import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ethers } from 'ethers';
import { getContract, CONTRACT_ADDRESS } from '../src/contract-client.mjs';
import { checkAndTriggerPolicy, checkAllPolicies } from '../src/monitor.mjs';
import { assessStormRisk } from '../src/decision-engine.mjs';
import {
  getBondedContract,
  BONDED_ADDRESS,
  AGENT_BOND_WEI,
  LIVENESS_SECONDS,
  ARBITER_ADDRESS,
  AssertionState,
} from '../src/bonded-client.mjs';
import { assertPolicyIfTriggered, finalizeMatured, sweepBonded } from '../src/bonded-monitor.mjs';

const server = new McpServer({ name: 'stormpolicy', version: '1.0.0' });

server.registerTool(
  'create_storm_policy',
  {
    title: 'Create a parametric storm insurance policy',
    description:
      'Fund and register a new parametric storm policy on-chain (Base Sepolia). ' +
      'The attached payout is released automatically -- no human in the loop -- ' +
      'once our agent cross-corroborates a real, live Telegraph WEATHER_FORECAST ' +
      'and STORM_ALERT signal for the given location above a confidence-calibrated ' +
      'severity threshold. Returns the on-chain policy ID and transaction hash.',
    inputSchema: {
      beneficiary: z.string().describe('EVM address to receive the payout if the policy triggers'),
      location: z.string().describe('Human-readable location this policy covers, e.g. "Manila, Philippines"'),
      payoutEth: z.string().describe('Payout amount in ETH as a decimal string, e.g. "0.0001"'),
    },
  },
  async ({ beneficiary, location, payoutEth }) => {
    const { contract } = getContract();
    const value = ethers.parseEther(payoutEth);
    const tx = await contract.createPolicy(beneficiary, location, { value });
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'PolicyCreated');
    const result = {
      policyId: log.args.policyId.toString(),
      contract: CONTRACT_ADDRESS,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      beneficiary,
      location,
      payoutEth,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  'assess_storm_risk',
  {
    title: 'Assess live storm risk for a location (read-only, no on-chain action)',
    description:
      'Calls real, live Telegraph WEATHER_FORECAST and STORM_ALERT miners for the ' +
      'given location (paid via x402), cross-corroborates them, and applies a ' +
      'confidence-calibrated threshold. Does not touch the contract -- use this to ' +
      'preview a decision before creating or triggering a policy.',
    inputSchema: {
      location: z.string().describe('Location to assess, e.g. "Manila, Philippines"'),
    },
  },
  async ({ location }) => {
    const decision = await assessStormRisk(location);
    const result = {
      location,
      shouldTrigger: decision.shouldTrigger,
      reason: decision.reason,
      forecastSignalHash: decision.forecastSignalHash,
      alertSignalHash: decision.alertSignalHash,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  'check_policy',
  {
    title: 'Check and, if warranted, trigger a specific storm policy',
    description:
      'Assesses live Telegraph signals for one on-chain policy by ID and, if the ' +
      'cross-corroborated decision says the threshold is crossed, submits the ' +
      'on-chain payout with the full evidence trail (both signal hashes, both ' +
      'confidence values, the reasoning) attached to the transaction.',
    inputSchema: {
      policyId: z.string().describe('The on-chain policy ID to check'),
    },
  },
  async ({ policyId }) => {
    const result = await checkAndTriggerPolicy(BigInt(policyId));
    const out = {
      policyId: result.policyId?.toString?.() ?? policyId,
      triggered: !!result.triggered,
      skipped: !!result.skipped,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      reason: result.decision?.reason || result.reason,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  'sweep_all_policies',
  {
    title: 'Check every active policy on the contract',
    description:
      'Iterates every policy registered on the StormPolicy contract, assessing ' +
      'live Telegraph signals for each active one and triggering payout for any ' +
      'that cross the calibrated threshold. Intended to be called on a schedule ' +
      'for persistent, autonomous monitoring rather than a one-off check.',
    inputSchema: {},
  },
  async () => {
    const results = await checkAllPolicies();
    const out = results.map((r) => ({
      policyId: r.policyId?.toString?.(),
      triggered: !!r.triggered,
      skipped: !!r.skipped,
      txHash: r.txHash,
      reason: r.decision?.reason || r.reason,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Bonded contract: the agent stakes a bond behind an assertion and the
// payout only moves after a dispute window closes unchallenged.
// ─────────────────────────────────────────────────────────────────────────

server.registerTool(
  'create_bonded_policy',
  {
    title: 'Create a policy on the bonded (disputable) contract',
    description:
      'Fund and register a policy on the bonded StormPolicy contract. Unlike the ' +
      'base contract, a trigger here is not immediate: the agent stakes a bond ' +
      'behind an assertion, anyone can dispute it by matching that bond during the ' +
      'liveness window, and the payout only releases if the window closes ' +
      'unchallenged (or an arbiter rules the agent was right).',
    inputSchema: {
      beneficiary: z.string().describe('EVM address to receive the payout if the policy triggers'),
      location: z.string().describe('Human-readable location this policy covers, e.g. "Manila, Philippines"'),
      payoutEth: z.string().describe('Payout amount in ETH as a decimal string, e.g. "0.00001"'),
    },
  },
  async ({ beneficiary, location, payoutEth }) => {
    const { contract } = getBondedContract();
    const tx = await contract.createPolicy(beneficiary, location, { value: ethers.parseEther(payoutEth) });
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === 'PolicyCreated');
    const result = {
      policyId: log.args.policyId.toString(),
      contract: BONDED_ADDRESS,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      beneficiary,
      location,
      payoutEth,
      bondEth: ethers.formatEther(AGENT_BOND_WEI),
      livenessSeconds: LIVENESS_SECONDS,
      arbiter: ARBITER_ADDRESS,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  'assert_bonded_policy',
  {
    title: 'Stake a bond and assert that a bonded policy should trigger',
    description:
      'Assesses live Telegraph signals for one policy on the bonded contract and, ' +
      'if the cross-corroborated decision crosses the calibrated threshold, stakes ' +
      "the agent's bond behind an on-chain assertion carrying the full evidence " +
      'trail. This opens the dispute window; it does NOT pay out yet.',
    inputSchema: {
      policyId: z.string().describe('The on-chain policy ID on the bonded contract'),
    },
  },
  async ({ policyId }) => {
    const result = await assertPolicyIfTriggered(BigInt(policyId));
    const out = {
      policyId: result.policyId?.toString?.() ?? policyId,
      asserted: !!result.asserted,
      skipped: !!result.skipped,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      bondEth: ethers.formatEther(AGENT_BOND_WEI),
      reason: result.decision?.reason || result.reason,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  'get_bonded_assertion',
  {
    title: 'Read the assertion state and evidence for a bonded policy',
    description:
      'Returns the current assertion on a bonded policy: its state (None, Pending, ' +
      'Disputed, Resolved), the staked bond, when the dispute window closes, who ' +
      'disputed it if anyone, and the full evidence the agent attached.',
    inputSchema: {
      policyId: z.string().describe('The on-chain policy ID on the bonded contract'),
    },
  },
  async ({ policyId }) => {
    const { contract } = getBondedContract();
    const a = await contract.getAssertion(BigInt(policyId));
    const p = await contract.getPolicy(BigInt(policyId));
    const stateName = ['None', 'Pending', 'Disputed', 'Resolved'][Number(a.state)] ?? 'Unknown';
    const now = Math.floor(Date.now() / 1000);
    const out = {
      policyId,
      contract: BONDED_ADDRESS,
      location: p.location,
      payoutEth: ethers.formatEther(p.payoutAmount),
      policyActive: p.active,
      policyTriggered: p.triggered,
      assertionState: stateName,
      bondEth: a.bondAmount > 0n ? ethers.formatEther(a.bondAmount) : null,
      disputer: a.disputer === ethers.ZeroAddress ? null : a.disputer,
      livenessEnds: a.livenessEnds > 0n ? Number(a.livenessEnds) : null,
      secondsUntilFinalizable:
        Number(a.state) === AssertionState.Pending ? Math.max(0, Number(a.livenessEnds) - now) : null,
      forecastSignalHash: a.forecastSignalHash,
      alertSignalHash: a.alertSignalHash,
      forecastConfidencePct: Number(a.forecastConfidenceBps) / 100,
      alertConfidencePct: Number(a.alertConfidenceBps) / 100,
      reason: a.reason,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  'finalize_matured_assertions',
  {
    title: 'Release payouts for assertions whose dispute window closed unchallenged',
    description:
      'Finalizes every bonded assertion whose liveness window has expired without a ' +
      'dispute: the payout goes to the beneficiary and the bond returns to the ' +
      'agent. This call is permissionless by design -- anyone can run it.',
    inputSchema: {},
  },
  async () => {
    const finalized = await finalizeMatured();
    return { content: [{ type: 'text', text: JSON.stringify({ finalized }, null, 2) }] };
  },
);

server.registerTool(
  'sweep_bonded_policies',
  {
    title: 'One full pass over the bonded contract',
    description:
      'Finalizes anything whose dispute window has matured, then assesses every ' +
      'active policy with no assertion against it and stakes a bonded assertion for ' +
      'any that cross the calibrated threshold. This is what the scheduled ' +
      'autonomous monitor runs.',
    inputSchema: {},
  },
  async () => {
    const result = await sweepBonded();
    const out = {
      finalized: result.finalized,
      asserted: result.asserted.map((r) => ({
        policyId: r.policyId?.toString?.(),
        asserted: !!r.asserted,
        skipped: !!r.skipped,
        txHash: r.txHash,
        reason: r.decision?.reason || r.reason,
      })),
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
