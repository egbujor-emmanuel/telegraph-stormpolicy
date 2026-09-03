/// Compares how different miners answer the SAME intent, by calling each
/// one directly instead of letting the router choose. Where the router
/// study shows what an application receives in practice, this shows the
/// spread it is being selected from.
///
/// Miners declare their own endpoints, so when a guessed endpoint is
/// rejected the engine helpfully names the declared one -- that response is
/// parsed and the call retried against it.
import { config } from 'dotenv';
config({ quiet: true });
import fs from 'node:fs';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const ENGINE = 'https://devnote.telegraphprotocol.com/engine'.replace('devnote', 'devnode');
const LOCATION = 'Manila, Philippines';

// Miners observed serving these two intents through the router. The guessed
// endpoint is corrected automatically from the engine's own reply when wrong.
const TARGETS = [
  { intent: 'WEATHER_FORECAST', minerId: 4433, guess: '/weather-forecast' },
  { intent: 'WEATHER_FORECAST', minerId: 910, guess: '/forecast' },
  { intent: 'STORM_ALERT', minerId: 7306, guess: '/storm' },
];

const account = privateKeyToAccount(process.env.TEST_WALLET_PRIVATE_KEY);
const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:84532', client: new ExactEvmScheme(account) }],
});

async function call(minerId, endpoint, acknowledgeWarnings = false) {
  const body = { method: 'POST', endpoint, payload: { location: LOCATION } };
  // The engine runs a pre-flight check and returns 422 with the miner's own
  // parameter warnings rather than spending the call. Acknowledging them
  // runs it anyway -- billed only if it actually executes.
  if (acknowledgeWarnings) body.acknowledge_warnings = true;
  const res = await payingFetch(`${ENGINE}/v1/ask/${minerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

/// The engine names the miner's real endpoints when a guess is wrong.
function declaredEndpointFrom(json) {
  const msg = json?.error ?? json?.result?.error ?? '';
  const m = String(msg).match(/declared endpoints:\s*([^"]+)/i);
  return m ? m[1].split(',')[0].trim() : null;
}

const findings = [];

for (const { intent, minerId, guess } of TARGETS) {
  process.stdout.write(`${intent} miner ${minerId} ... `);
  try {
    let endpoint = guess;
    let { status, json } = await call(minerId, endpoint);

    const declared = declaredEndpointFrom(json);
    if (declared && declared !== endpoint) {
      endpoint = declared;
      ({ status, json } = await call(minerId, endpoint));
    }
    if (status === 422 && json?.proceed_anyway) {
      ({ status, json } = await call(minerId, endpoint, true));
    }

    const result = json?.result ?? null;
    const keys = result && typeof result === 'object' ? Object.keys(result).sort() : [];
    findings.push({
      intent, minerId, endpoint, status,
      minerName: json?.miner_name ?? null,
      resultKeys: keys,
      sample: result ? JSON.stringify(result).slice(0, 400) : (json ? JSON.stringify(json).slice(0, 250) : null),
    });
    console.log(`endpoint=${endpoint} status=${status} keys=[${keys.join(',')}]`);
  } catch (err) {
    findings.push({ intent, minerId, error: String(err.message).slice(0, 200) });
    console.log(`failed: ${String(err.message).slice(0, 90)}`);
  }
}

fs.writeFileSync('./study-miner-comparison.json', JSON.stringify(findings, null, 2));
console.log('\nSaved to study-miner-comparison.json');

for (const intent of ['WEATHER_FORECAST', 'STORM_ALERT']) {
  const forIntent = findings.filter(f => f.intent === intent && f.resultKeys?.length);
  const endpoints = new Set(forIntent.map(f => f.endpoint));
  const shapes = new Set(forIntent.map(f => f.resultKeys.join(',')));
  console.log(`${intent}: ${forIntent.length} miners answered, ${endpoints.size} distinct endpoint path(s), ${shapes.size} distinct response shape(s)`);
}
