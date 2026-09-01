import { askTelegraph } from './src/telegraph-client.mjs';

(async () => {
  console.log('--- Auto-routed ask: storm alert ---');
  const alert = await askTelegraph('Is there an active storm alert or severe weather warning for Manila, Philippines right now?');
  console.log(JSON.stringify(alert, null, 2));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
