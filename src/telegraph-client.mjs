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

/// Auto-routed ask: Telegraph's LLM router classifies the query into an
/// Intent and picks the top-ranked miner for it -- this is the real
/// "quality flywheel" mechanism (ranking + probabilistic routing), not a
/// call to a hardcoded miner ID.
export async function askTelegraph(query, context = undefined) {
  const payingFetch = getPayingFetch();
  const body = { query };
  if (context) body.context = context;

  const res = await payingFetch(`${ENGINE_URL}/v1/ask`, {
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
