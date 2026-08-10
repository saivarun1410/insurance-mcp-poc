// Spawns the MCP server over stdio as a real MCP client and exercises every tool.
// This is the proof the server works end to end — `npm run smoke`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../src/index.js', import.meta.url).pathname],
  env: process.env,
});

const client = new Client({ name: 'smoke-test', version: '0.1.0' });
await client.connect(transport);

function show(label, result) {
  console.log(`\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}`);
  console.log(result.content.map((part) => part.text).join('\n'));
}

const { tools } = await client.listTools();
console.log(`Connected. Server exposes ${tools.length} tools:`);
for (const tool of tools) console.log(`  - ${tool.name}: ${tool.title ?? ''}`);

show(
  'search_policy_documents  ->  "what happens if the insured dies by suicide"',
  await client.callTool({
    name: 'search_policy_documents',
    arguments: { query: 'what happens if the insured dies by suicide within two years', limit: 2 },
  }),
);

show(
  'search_policy_documents  ->  "accelerated underwriting exam waived" (TRM-20 only)',
  await client.callTool({
    name: 'search_policy_documents',
    arguments: { query: 'accelerated underwriting paramedical examination waived', product_code: 'TRM-20', limit: 2 },
  }),
);

show(
  'get_application_status  ->  APP-100242',
  await client.callTool({
    name: 'get_application_status',
    arguments: { application_number: 'APP-100242' },
  }),
);

show(
  'get_application_status  ->  APP-999999 (missing)',
  await client.callTool({
    name: 'get_application_status',
    arguments: { application_number: 'APP-999999' },
  }),
);

show(
  'lookup_product_rules  ->  VUL-300, age 72, $500k, CA (should be ineligible on age)',
  await client.callTool({
    name: 'lookup_product_rules',
    arguments: { product_code: 'VUL-300', applicant_age: 72, face_amount: 500000, state: 'CA' },
  }),
);

show(
  'lookup_product_rules  ->  TRM-20, age 34, $250k, TX (should be eligible)',
  await client.callTool({
    name: 'lookup_product_rules',
    arguments: { product_code: 'TRM-20', applicant_age: 34, face_amount: 250000, state: 'TX' },
  }),
);

await client.close();
console.log('\nAll tool calls completed.');
process.exit(0);
