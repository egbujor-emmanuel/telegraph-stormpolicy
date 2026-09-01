import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ethers } from 'ethers';
import { getContract, CONTRACT_ADDRESS } from '../src/contract-client.mjs';
import { checkAndTriggerPolicy, checkAllPolicies } from '../src/monitor.mjs';
import { assessStormRisk } from '../src/decision-engine.mjs';

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

const transport = new StdioServerTransport();
await server.connect(transport);
