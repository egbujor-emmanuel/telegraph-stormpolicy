# StormPolicy

A parametric storm-insurance protocol built on Telegraph Protocol for the Track 3 (Applications) hackathon track. It cross-corroborates two real, live Telegraph intents, applies a confidence-calibrated and location-bound threshold, and autonomously executes a bounded on-chain payout — with no human in the loop and the full evidence trail stored on-chain.

**Live:** [egbujor-emmanuel.github.io/telegraph-stormpolicy](https://egbujor-emmanuel.github.io/telegraph-stormpolicy/) — a static site that reads policies straight off Base Sepolia in the browser. Behind it, a [GitHub Actions job](.github/workflows/monitor.yml) is scheduled every 15 minutes to check every active policy against live Telegraph signals and trigger payouts autonomously — free and unlimited on a public repo, with no server to keep alive and no spin-down risk. In practice GitHub's cron scheduler is best-effort, not to-the-minute: observed cadence on this repo has been every 2–5 hours rather than every 15 minutes. The job itself is correct and does trigger real payouts when it runs (verified: [`f94f0cb`](https://sepolia.basescan.org/tx/0xf94f0cb6cfef53b6826ba7e87c8c502e33572a1949485403f1380d16f7f0f0de)) — the gap is GitHub's scheduler, not the logic.

## Why this, specifically

Telegraph's own hackathon rules name "verified intelligence directly triggering on-chain actions — trading, liquidations, arbitrage, compliance checks, treasury management" as one of the highest-value areas for Track 3. A survey of all six existing official Telegraph use-cases (AdGuard, ReviewRadar, ScholarGuard, TrustFilter, TruthWire, SuperSignal) found that every one of them lives in AI-content-detection, and none of them has a smart contract autonomously executing a decision — the closest, SuperSignal, still stores its decision off-chain. Financial & On-Chain and Weather & Sports, the two intent categories StormPolicy uses, are untouched by any existing example. This targets that gap directly.

## How it works

1. **`StormPolicy.sol`** (deployed on Base Sepolia) is a minimal parametric-insurance primitive: anyone can fund and register a policy (location, beneficiary, payout amount). A single authorized agent address can trigger a policy's payout exactly once, and must attach the full evidence — both signal hashes, both confidence values, a human-readable reason — as part of that call, so the decision is auditable on a block explorer, not just asserted.
2. **The decision engine** (`src/decision-engine.mjs`) calls Telegraph's real, auto-routed Engine API (`POST /engine/v1/ask`, paid via x402) for both `WEATHER_FORECAST` and `STORM_ALERT` for a policy's location — auto-routed, not a hardcoded miner ID, so it actually exercises Telegraph's probabilistic ranking/routing rather than bypassing it.
3. It **cross-corroborates**: both signals must independently indicate severity above threshold. Neither one alone is enough.
4. It **calibrates confidence**, not just severity: a forecast miner reporting low confidence in its own data holds the decision regardless of how severe the numbers look. This is a direct, deliberate lesson from this project's own Track 2 WASM-scoring work, where a candidate scored 100% on a rigorous offline adversarial test yet only 7/15 live against the real evaluator — stated confidence and real correctness are not the same thing, and this project does not repeat that mistake by trusting a single self-reported number.
5. It **binds signals to the policy's location**, not just to a severity number. During real testing (not staged) against Jakarta, Indonesia — a location never touched before — the STORM_ALERT miner returned a signal scoped to "South China Sea" rather than Jakarta itself. The entity-binding check caught this live and correctly held instead of releasing a payout on a right-severity, wrong-place signal.
6. If — and only if — all of the above hold, `triggerPayout` is called on-chain and funds move automatically.

## MCP tools

The same pipeline is exposed as an MCP server (`mcp/server.mjs`) so any MCP-speaking agent (Claude Desktop, Cursor, ElizaOS, etc.) can create and monitor policies directly:

| Tool | Does |
|---|---|
| `create_storm_policy` | Fund and register a new policy on-chain |
| `assess_storm_risk` | Read-only preview of the corroboration decision for a location |
| `check_policy` | Assess and, if warranted, trigger one policy by ID |
| `sweep_all_policies` | Check every active policy — the persistent-monitoring entry point |

Verified against the real MCP protocol with `npm run test:mcp`, which spawns the server over stdio with the official SDK's `Client`/`StdioClientTransport` (the same transport any MCP host uses) and calls a live tool — this is the run that first caught the Jakarta/"South China Sea" entity-binding mismatch, unscripted. To point Claude Desktop at it, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stormpolicy": {
      "command": "node",
      "args": ["/absolute/path/to/telegraph-stormpolicy/mcp/server.mjs"],
      "env": { "TEST_WALLET_PRIVATE_KEY": "0x..." }
    }
  }
}
```

## Verified live run

Policy 1, Manila, Philippines, `0.00002 ETH` payout:
- `createPolicy` tx: `0x23f178387092b69eb391b8092dcfbbd0056cb337d6a3ad89431e9fe405e030b8`
- Real signals pulled live: WEATHER_FORECAST confidence 1.00 (precip 100%, gust 56.3 km/h), STORM_ALERT risk 0.82 ("high")
- Decision: **TRIGGER** — both corroborated, both bound to Manila
- `triggerPayout` tx: `0xf94f0cb6cfef53b6826ba7e87c8c502e33572a1949485403f1380d16f7f0f0de`, block `46260712`

Contract: `0xFDB301bB77e82B5CB75D9768C79B4d3Af2D19424` (Base Sepolia)

## Running it

```bash
npm install
npm run compile      # solc compiles contracts/StormPolicy.sol
npm run deploy        # deploys to Base Sepolia, saves build/deployment.json
npm run test:contract # end-to-end contract behavior checks
npm run demo           # creates a real policy and assesses it against live signals
npm run mcp             # starts the MCP server (stdio)
npm run test:mcp       # smoke-tests the MCP server's tools
```

Requires `TEST_WALLET_PRIVATE_KEY` (funded with Base Sepolia ETH for gas and USDC for x402 payments) available via the same `.env` convention used elsewhere in this project.

`server/index.mjs` (an Express API with an agent-key-gated "assess"/"check now" surface) is kept as a local dev/testing convenience — the deployed site at the link above no longer depends on it; it reads the contract directly, and the real trigger loop is the scheduled GitHub Actions job, not this server.

## Skin in the game: the bonded contract

The first version of this README listed a bond/slashing mechanism as the obvious next step and deliberately left it out. It's now built, deployed, and tested.

**[`StormPolicyBonded.sol`](contracts/StormPolicyBonded.sol)** — [`0xE3ED291780d967dB04396f4d7b9f4b18c860c68f`](https://sepolia.basescan.org/address/0xE3ED291780d967dB04396f4d7b9f4b18c860c68f) on Base Sepolia.

Instead of the agent paying out directly, it now has to put money behind its claim:

1. **Assert.** The agent stakes a bond and asserts a policy should trigger, with the same evidence trail attached. No funds move yet.
2. **Dispute window.** For the liveness period that follows, anyone can dispute by matching the bond.
3. **Finalize.** If nobody disputes, *anyone* can finalize — the payout releases and the bond returns. This is the expected common case.
4. **Arbitrate.** If disputed, an arbiter rules. The loser's bond goes to the winner. If the agent was wrong, the payout never happens and the policy stays open.

So a dishonest or sloppy trigger stops being free: asserting something false costs the agent its bond, and catching a false assertion pays the person who caught it.

### Where the design comes from

This follows [UMA's Optimistic Oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work) — a bonded assertion accepted automatically unless challenged within a liveness window (UMA defaults to two hours, configurable up to two days) — combined with [Reality.eth](https://realitio.github.io/docs/html/arbitrators.html)'s idea that a matching bond is what buys you the right to challenge an answer.

### What is still simplified, honestly

- **A single trusted arbiter, not a decentralized court.** UMA escalates to its DVM (a token-holder commit-reveal vote); Reality.eth escalates bonds across multiple rounds before falling back to an arbitrator contract. Both are substantial systems in their own right. This contract goes straight from "disputed" to one arbiter address, which is a real centralization point. Notably, production parametric insurers ([Arbol](https://www.arbol.io/post/smart-contracts-and-blockchain-can-help-close-the-global-protection-gap-enable-businesses-to-build-climate-resilience), Etherisc) make the same trade today — a trusted party as the oracle-dispute fallback. The difference here is that it's wired through a real bond/slash mechanism rather than an unaccountable admin pause. The role can be handed to a multisig via `updateArbiter` without redeploying.
- **Fixed bond size**, set at deploy time, not scaled to each policy's payout.
- **No timeout if the arbiter goes silent** on a live dispute.

### Verified

`npm run test:bonded` — **25/25 passing** against the live contract on Base Sepolia, covering all three economic outcomes (undisputed finalize; disputed with the agent vindicated; disputed with the agent slashed) plus nine revert guards. Balance assertions account for the OP-stack L1 data fee, so value conservation is checked exactly rather than approximately.
