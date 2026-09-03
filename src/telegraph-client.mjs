import { config } from 'dotenv';
config({ quiet: true });
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const ENGINE_URL = 'https://devnode.telegraphprotocol.com/engine';
const BASE_SEPOLIA_CAIP2 = 'eip155:84532';

function loadPrivateKey() {
  const pk = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('TEST_WALLET_PRIVATE_KEY is not set (expected in .env or the environment)');
  return pk;
}

let _fetchWithPayment = null;
function getPayingFetch() {
  if (!_fetchWithPayment) {
    const account = privateKeyToAccount(loadPrivateKey());
    _fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [
        { network: BASE_SEPOLIA_CAIP2, client: new ExactEvmScheme(account) },
      ],
    });
  }
  return _fetchWithPayment;
}

/// The x402 payment handshake occasionally surfaces an empty-bodied 402
/// instead of completing the sign-and-retry. It clears on a retry -- but an
/// unretried one used to abort an entire scheduled sweep, so no policy got
/// checked because of one hiccup on one call.
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Distinguishes "try again, this is the network being flaky" from "this
/// request is wrong and will fail identically forever". Retrying the latter
/// just wastes a scheduled run's time budget.
export function isTransient(err) {
  const m = String(err?.message ?? '');
  return m.includes('Non-JSON response')
    || m.includes('status 402')
    || m.includes('status 429')
    || m.includes('status 500')
    || m.includes('status 502')
    || m.includes('status 503')
    || m.includes('status 504')
    || m.includes('fetch failed')
    || m.includes('ETIMEDOUT')
    || m.includes('ECONNRESET');
}

/// Retries an operation while its failure looks transient. Exported
/// separately from askTelegraph so the retry policy can be tested
/// deterministically, without live network calls or real payments.
export async function withRetry(fn, { attempts = MAX_ATTEMPTS, delayMs = RETRY_DELAY_MS, label = 'telegraph' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) break;
      console.warn(`[${label}] transient failure (attempt ${attempt}/${attempts}): ${String(err.message).slice(0, 120)} -- retrying`);
      await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

/// Auto-routed ask: Telegraph's LLM router classifies the query into an
/// Intent and picks the top-ranked miner for it -- this is the real
/// "quality flywheel" mechanism (ranking + probabilistic routing), not a
/// call to a hardcoded miner ID.
export async function askTelegraph(query, context = undefined) {
  return withRetry(() => askTelegraphOnce(query, context));
}

/// Direct ask against one specific miner, bypassing the router. The
/// production path deliberately does NOT use this -- routing is the
/// mechanism worth exercising. It exists so the compatibility study can
/// compare how different miners answer the same intent.
export async function askMiner(minerId, query, context = undefined) {
  return withRetry(() => askTelegraphOnce(query, context, minerId));
}

async function askTelegraphOnce(query, context, minerId) {
  const payingFetch = getPayingFetch();
  const body = { query };
  if (context) body.context = context;

  const path = minerId ? `/v1/ask/${minerId}` : '/v1/ask';
  const res = await payingFetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (status ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`Engine ask failed (status ${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}
