import { askTelegraph } from './src/telegraph-client.mjs';

(async () => {
  console.log('--- Auto-routed ask: weather forecast ---');
  const forecast = await askTelegraph('What is the 24-hour weather forecast for Manila, Philippines starting today, including temperature, precipitation probability, and wind speed?');
  console.log(JSON.stringify(forecast, null, 2));
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
