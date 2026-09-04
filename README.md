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

## What routing actually returns: a compatibility study

Telegraph routes by **intent**, not by miner: an application asks a question and the network's own ranking decides who answers. That is the mechanism worth exercising, and it is the one this project uses in production — `POST /engine/v1/ask`, never a pinned miner ID.

It also means the response schema is not a constant. Miners implement the same intent independently, declare their own endpoints, and shape their output as they see fit. Rather than assume how wide that spread is, we measured it.

**Method.** [`study-miner-shapes.mjs`](study-miner-shapes.mjs) makes real, x402-paid, auto-routed calls for both intents across 12 locations on five continents, recording which miner the router selected, the response shape, and whether two different consumers can derive what they need — a **canonical-field reader** (reads the documented structured field names, a reasonable first integration) versus this project's **shape-agnostic adapter**. [`study-miner-comparison.mjs`](study-miner-comparison.mjs) then bypasses the router to call individual miners directly and compare them side by side. Every number below regenerates with `npm run study:report` from the committed raw data.

**Result** — 24 routed calls, 12 locations, $0.24 total, zero failures, median latency 2.0s:

| | canonical-field reader | shape-agnostic adapter |
|---|---|---|
| `WEATHER_FORECAST` severity derivable | **0 / 12 (0%)** | 12 / 12 (100%) |
| `STORM_ALERT` severity derivable | **0 / 12 (0%)** | 12 / 12 (100%) |
| Signal bound to the requested place | — | 24 / 24 (100%) |

**Why the spread is that wide.** Calling two `WEATHER_FORECAST` miners directly shows how independently they are built:

| miner | declared endpoint | result fields |
|---|---|---|
| 4433 · LiveCert Operational Signals | `/weather-forecast` | `confidence`, `reason`, `verdict` — the forecast itself is an English sentence |
| 910 · OnLookout Weather Forecast | `/forecast` | `answer`, `as_of`, `canonical`, `confidence`, `days`, `forecast`, `location`, `risk_flags`, `source`, `summary` |

Two miners, the same intent, and **exactly one field name in common** (`confidence`). One returns hourly and daily series in millimetres and metres per second; the other returns prose with the numbers inside it. The `STORM_ALERT` miner (7306 · SkyWire, endpoint `/storm`) is different again, reporting `level`, `breach`, `official_alerts` and raw measurements with no single risk score at all.

**What this means for anyone building on Telegraph.** Which miner answers is a ranking decision, and ranking is exactly what the flywheel is supposed to change. So the schema an application receives is a property of the network *at call time*, not a fixed contract. An integration written against one miner's field names keeps returning HTTP 200 after the router moves on — it simply stops finding the fields it was looking for. For a consumer that acts on thresholds, that reads as *"conditions are never severe"* rather than as a failure, which is the quietest possible way for an automated system to be wrong.

This project therefore treats parsing as an **adapter layer**, not field access:

- severity is derived from whichever representation is present — probability, millimetres, an m/s series, declared risk flags, official alerts, a threshold breach, or prose;
- an explicit numeric reading is never inflated by that same miner's coarser label, so a precise `0.57` cannot be rounded up into a payout by the word next to it;
- when nothing usable is present the signal is `null` and the decision holds — it **fails closed, never open**;
- readings parsed from prose are recorded as prose-derived, so weaker evidence is visible in the on-chain reason instead of silently ranking equal to structured fields.

[73 conformance tests](test-regressions.mjs) pin these guarantees against captured live responses from every miner shape above, and run in CI on every push.

## MCP tools

The same pipeline is exposed as an MCP server (`mcp/server.mjs`) so any MCP-speaking agent (Claude Desktop, Cursor, ElizaOS, etc.) can create and monitor policies directly:

| Tool | Does |
|---|---|
| `create_storm_policy` | Fund and register a new policy on-chain |
| `assess_storm_risk` | Read-only preview of the corroboration decision for a location |
| `check_policy` | Assess and, if warranted, trigger one policy by ID |
| `sweep_all_policies` | Check every active policy — the persistent-monitoring entry point |

**Connected to a real agent runtime, not just documented.** The server is registered with Claude Code — itself an MCP host — and reports healthy from the host's own health check:

```
$ claude mcp list
stormpolicy: node .../mcp/server.mjs - ✔ Connected
```

Add it to any MCP host the same way:

```bash
claude mcp add stormpolicy -- node /absolute/path/to/telegraph-stormpolicy/mcp/server.mjs
```

It is also verified against the raw protocol with `npm run test:mcp`, which spawns the server over stdio using the official SDK's `Client`/`StdioClientTransport` (the same transport any MCP host uses) and calls a live tool — this is the run that first caught the Jakarta/"South China Sea" entity-binding mismatch, unscripted. For Claude Desktop, the equivalent entry in `claude_desktop_config.json` is:

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

**[`StormPolicyBonded.sol`](contracts/StormPolicyBonded.sol)** — [`0xECb611641342A0EF514B1D4e425b51dF0bf4f9bE`](https://sepolia.basescan.org/address/0xECb611641342A0EF514B1D4e425b51dF0bf4f9bE) on Base Sepolia.

Instead of the agent paying out directly, it now has to put money behind its claim:

1. **Assert.** The agent stakes a bond and asserts a policy should trigger, with the same evidence trail attached. No funds move yet.
2. **Dispute window.** For the liveness period that follows, anyone can dispute by matching the bond.
3. **Finalize.** If nobody disputes, *anyone* can finalize — the payout releases and the bond returns. This is the expected common case.
4. **Arbitrate.** If disputed, an arbiter rules. The loser's bond goes to the winner. If the agent was wrong, the payout never happens and the assertion is cleared — cover has to survive being wrong once, since the storm the agent was wrong about may still arrive, so the policy returns to an assertable state rather than sitting funded but unusable.

So a dishonest or sloppy trigger stops being free: asserting something false costs the agent its bond, and catching a false assertion pays the person who caught it.

### Where the design comes from

This follows [UMA's Optimistic Oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work) — a bonded assertion accepted automatically unless challenged within a liveness window (UMA defaults to two hours, configurable up to two days) — combined with [Reality.eth](https://realitio.github.io/docs/html/arbitrators.html)'s idea that a matching bond is what buys you the right to challenge an answer.

### What is still simplified, honestly

- **A single trusted arbiter, not a decentralized court.** UMA escalates to its DVM (a token-holder commit-reveal vote); Reality.eth escalates bonds across multiple rounds before falling back to an arbitrator contract. Both are substantial systems in their own right. This contract goes straight from "disputed" to one arbiter address, which is a real centralization point. Notably, production parametric insurers ([Arbol](https://www.arbol.io/post/smart-contracts-and-blockchain-can-help-close-the-global-protection-gap-enable-businesses-to-build-climate-resilience), Etherisc) make the same trade today — a trusted party as the oracle-dispute fallback. The difference here is that it's wired through a real bond/slash mechanism rather than an unaccountable admin pause. The role can be handed to a multisig via `updateArbiter` without redeploying.
- **No multi-round bond escalation.** A dispute is one matched bond and then arbitration, not Reality.eth's ladder of doubling stakes.

### What the earlier version left open, now closed

Two limitations listed here previously have been implemented rather than left as future work:

- **The bond scales with the payout.** A flat bond means the incentive to be careful shrinks as the payout grows. `requiredBond(policyId)` is `max(minBond, payout × bondBps)` — 20% of the money the claim would move, with a floor so dust-sized policies still cost something to assert. Asserting with the old flat amount on a large policy now reverts.
- **A silent arbiter can no longer freeze funds.** `resolveStale(policyId)` lets *anyone* unwind a dispute the arbiter never answered, once the timeout has passed. Both bonds are returned and the assertion clears: neither side is punished for a third party's inaction, and the policy is assertable again. Verified by a test that deliberately never rules and waits out the real on-chain timeout.

### Verified

`npm run test:bonded` — **25/25 passing** against the live contract on Base Sepolia, covering all three economic outcomes (undisputed finalize; disputed with the agent vindicated; disputed with the agent slashed) plus nine revert guards. Balance assertions account for the OP-stack L1 data fee, so value conservation is checked exactly rather than approximately.
