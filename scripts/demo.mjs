// Walks the chained flow an agent performs for a question that no single tool answers:
//   "Application APP-100242 is stuck — what is it waiting on, and what does the
//    guideline actually say about that requirement?"
//
// Tool 1 finds the blocking step. Tool 2 looks up the rule behind it. The agent
// composes the answer with a citation. `npm run demo`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const APPLICATION = process.argv[2] ?? 'APP-100242';

const client = new Client({ name: 'demo', version: '0.1.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/index.js', import.meta.url).pathname],
    env: process.env,
  }),
);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content.map((part) => part.text).join('\n'));
};

console.log(`\nQ: "${APPLICATION} is stuck — what is it waiting on, and what does the guideline say?"\n`);

console.log(`  [1] calling get_application_status(application_number="${APPLICATION}")`);
const application = await call('get_application_status', { application_number: APPLICATION });
console.log(`      -> ${application.applicant_name}, age ${application.applicant_age}, ${application.product_name}`);
console.log(`      -> status=${application.status}  blocked on: ${application.current_step}`);

const triggers = application.timeline.filter((event) => event.event === 'rule_triggered');
const triggeredCodes = triggers.map((event) => event.detail.split(':')[0]);
console.log(`      -> rules fired: ${triggeredCodes.join(', ') || 'none'}`);

// The agent pulls the rule text behind the block, rather than guessing from the status slug.
console.log(`\n  [2] calling lookup_product_rules(product_code="${application.product_code}", applicant_age=${application.applicant_age}, face_amount=${application.face_amount})`);
const { rules } = await call('lookup_product_rules', {
  product_code: application.product_code,
  applicant_age: application.applicant_age,
  face_amount: Number(application.face_amount),
  state: application.applicant_state,
});
const firedRules = rules.filter((rule) => triggeredCodes.includes(rule.rule_code));
for (const rule of firedRules) console.log(`      -> ${rule.rule_code} [${rule.outcome}]: ${rule.description}`);

// A natural-language question retrieves far better than the underscored status slug.
const searchQuery = 'when is a paramedical examination required';
console.log(`\n  [3] calling search_policy_documents(query="${searchQuery}")`);
const [document] = await call('search_policy_documents', { query: searchQuery, limit: 1 });
console.log(`      -> ${document.doc_id}  (rrf ${document.score}, vector rank ${document.vector_rank}, text rank ${document.text_rank})`);
console.log(`      -> ${document.title}`);

console.log(`\n${'-'.repeat(72)}\nAnswer the agent can now give:\n${'-'.repeat(72)}`);
const amount = Number(application.face_amount).toLocaleString('en-US');
console.log(
  `${application.applicant_name}'s application (${application.product_name}, $${amount}) is ` +
    `${application.status.replace(/_/g, ' ')}, waiting on ${application.current_step.replace(/_/g, ' ')}.\n\n` +
    `Two rules fired, and at age ${application.applicant_age} with a $${amount} face amount ` +
    `this applicant trips both:\n` +
    firedRules.map((rule) => `  • ${rule.rule_code} [${rule.outcome}] — ${rule.description}`).join('\n') +
    `\n\nThe paramedical exam is what the case is actually waiting on. Per ${document.doc_id} — ` +
    `${document.title}:\n"${document.excerpt.slice(0, 300)}…"\n\n` +
    `(That guideline describes who may *skip* the exam: ages 18–44 at $250,000 or less. ` +
    `This applicant qualifies for neither, so the exam stands.)`,
);

await client.close();
process.exit(0);
