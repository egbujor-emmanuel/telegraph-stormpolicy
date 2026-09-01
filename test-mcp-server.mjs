import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./mcp/server.mjs'],
});

const client = new Client({ name: 'stormpolicy-test-client', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('=== Tools exposed ===');
for (const t of tools.tools) {
  console.log('-', t.name, ':', t.title || t.description?.slice(0, 60));
}

console.log('\n=== Calling assess_storm_risk (read-only, live) for Jakarta, Indonesia ===');
const result = await client.callTool({ name: 'assess_storm_risk', arguments: { location: 'Jakarta, Indonesia' } });
console.log(result.content[0].text);

await client.close();
process.exit(0);
