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

show(
  'find_applications  ->  everything untouched for 20+ days',
  await client.callTool({ name: 'find_applications', arguments: { stalled_days_min: 20 } }),
);

show(
  'get_outstanding_requirements  ->  overdue across the whole pipeline',
  await client.callTool({ name: 'get_outstanding_requirements', arguments: { overdue_only: true } }),
);

show(
  'find_eligible_products  ->  age 62, $2M, TX',
  await client.callTool({
    name: 'find_eligible_products',
    arguments: { applicant_age: 62, face_amount: 2000000, state: 'TX' },
  }),
);

show(
  'estimate_premium  ->  TRM-20, age 34, $250k, preferred',
  await client.callTool({
    name: 'estimate_premium',
    arguments: { product_code: 'TRM-20', applicant_age: 34, face_amount: 250000, risk_class: 'preferred' },
  }),
);

show(
  'estimate_premium  ->  age 90 (no rate band; should list what exists)',
  await client.callTool({
    name: 'estimate_premium',
    arguments: { product_code: 'TRM-20', applicant_age: 90, face_amount: 250000 },
  }),
);

show(
  'get_underwriter_workload  ->  triage view',
  await client.callTool({ name: 'get_underwriter_workload', arguments: {} }),
);

show(
  'add_case_note  ->  the one writing tool',
  await client.callTool({
    name: 'add_case_note',
    arguments: {
      application_number: 'APP-100243',
      note: 'Called provider; APS promised by Friday.',
      author: 'M. Alvarez',
    },
  }),
);

show(
  'add_case_note  ->  unknown application (must write nothing)',
  await client.callTool({
    name: 'add_case_note',
    arguments: { application_number: 'APP-999999', note: 'should not persist', author: 'test' },
  }),
);

show(
  'get_document  ->  UL200-CONTRACT-01 in full (search truncates it at 600 chars)',
  await client.callTool({ name: 'get_document', arguments: { doc_id: 'UL200-CONTRACT-01' } }),
);

show(
  'find_applicant  ->  "osei" (name, not application number)',
  await client.callTool({ name: 'find_applicant', arguments: { name: 'osei' } }),
);

show(
  'list_documents  ->  everything filed under TRM-20',
  await client.callTool({ name: 'list_documents', arguments: { product_code: 'TRM-20' } }),
);

show(
  'get_rate_card  ->  TRM-20, preferred class',
  await client.callTool({ name: 'get_rate_card', arguments: { product_code: 'TRM-20', risk_class: 'preferred' } }),
);

show(
  'get_pipeline_metrics  ->  book health',
  await client.callTool({ name: 'get_pipeline_metrics', arguments: {} }),
);

// The two tools below mutate, so this run's output differs from the next one's unless the
// database is rebuilt. That is the point of the second call in each pair.
show(
  'update_requirement_status  ->  APS received',
  await client.callTool({
    name: 'update_requirement_status',
    arguments: { application_number: 'APP-100243', requirement_code: 'APS', status: 'received', note: 'Received by fax' },
  }),
);

show(
  'update_requirement_status  ->  same call again (idempotent, must be a no-op)',
  await client.callTool({
    name: 'update_requirement_status',
    arguments: { application_number: 'APP-100243', requirement_code: 'APS', status: 'received' },
  }),
);

show(
  'reassign_application  ->  APP-100245 to S. Bhatt',
  await client.callTool({
    name: 'reassign_application',
    arguments: { application_number: 'APP-100245', to_underwriter: 'S. Bhatt', reason: 'D. Lindqvist at capacity' },
  }),
);

show(
  'reassign_application  ->  unknown application (must change nothing)',
  await client.callTool({
    name: 'reassign_application',
    arguments: { application_number: 'APP-999999', to_underwriter: 'S. Bhatt', reason: 'should not apply' },
  }),
);

show(
  'compare_products  ->  age 62, $2M, TX (one call instead of four)',
  await client.callTool({
    name: 'compare_products',
    arguments: { applicant_age: 62, face_amount: 2000000, state: 'TX' },
  }),
);

// APP-100244 keeps two outstanding requirements in the seed data, so this refusal is stable
// across runs — it demonstrates a guardrail no schema could express.
show(
  'record_underwriting_decision  ->  approve APP-100244 with requirements outstanding (must refuse)',
  await client.callTool({
    name: 'record_underwriting_decision',
    arguments: { application_number: 'APP-100244', decision: 'approved', reason: 'juvenile case looks fine' },
  }),
);

show(
  'record_underwriting_decision  ->  approved_rated with no risk_class (must refuse)',
  await client.callTool({
    name: 'record_underwriting_decision',
    arguments: { application_number: 'APP-100243', decision: 'approved_rated', reason: 'build rating' },
  }),
);

show(
  'order_requirement  ->  EKG on APP-100245 (second run reports it already outstanding)',
  await client.callTool({
    name: 'order_requirement',
    arguments: {
      application_number: 'APP-100245',
      requirement_code: 'EKG',
      description: 'Resting electrocardiogram',
      vendor: 'ExamOne',
    },
  }),
);

show(
  'create_application  ->  TRM-30 for a 62-year-old (max issue age 55, must refuse)',
  await client.callTool({
    name: 'create_application',
    arguments: { applicant_name: 'Nadia Fournier', applicant_age: 62, applicant_state: 'TX', product_code: 'TRM-30', face_amount: 500000 },
  }),
);

show(
  'create_application  ->  TRM-20 instead (eligible; each run creates a new number)',
  await client.callTool({
    name: 'create_application',
    arguments: { applicant_name: 'Nadia Fournier', applicant_age: 62, applicant_state: 'TX', product_code: 'TRM-20', face_amount: 500000, assigned_underwriter: 'S. Bhatt' },
  }),
);

show(
  'withdraw_application  ->  APP-100241 is approved (a decided case cannot be withdrawn)',
  await client.callTool({
    name: 'withdraw_application',
    arguments: { application_number: 'APP-100241', reason: 'applicant changed their mind' },
  }),
);

show(
  'amend_application  ->  raise APP-100243 to $4M on TRM-30 (max $3M, must refuse)',
  await client.callTool({
    name: 'amend_application',
    arguments: { application_number: 'APP-100243', face_amount: 4000000, reason: 'applicant wants more cover' },
  }),
);

show(
  'amend_application  ->  same case, moved to TRM-20 which allows $5M',
  await client.callTool({
    name: 'amend_application',
    arguments: { application_number: 'APP-100243', product_code: 'TRM-20', face_amount: 4000000, reason: 'switched product for the higher limit' },
  }),
);

show(
  'find_similar_documents  ->  what sits near the suicide exclusion',
  await client.callTool({ name: 'find_similar_documents', arguments: { doc_id: 'TRM20-CONTRACT-02' } }),
);

show(
  'get_requirement_catalog  ->  turnaround by requirement and by vendor',
  await client.callTool({ name: 'get_requirement_catalog', arguments: {} }),
);

await client.close();
console.log('\nAll tool calls completed.');
process.exit(0);
