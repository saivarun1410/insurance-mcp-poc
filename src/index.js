#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { query } from './db.js';
import { embed, toVectorLiteral } from './embed.js';

// This process speaks JSON-RPC on stdout, so ANY stray write there corrupts the stream and
// the client silently loses the connection. Model loaders and native runtimes are a common
// source of incidental logging, so route console.log to stderr before anything else runs.
console.log = (...args) => console.error(...args);

const server = new McpServer({ name: 'insurance-mcp-poc', version: '0.1.0' });

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

server.registerTool(
  'search_policy_documents',
  {
    title: 'Search policy documents',
    description:
      'Semantic search over policy contracts, riders, underwriting guidelines and disclosure documents. ' +
      'Use this to answer questions about what a policy says. Returns ranked excerpts with document ids.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string().describe('Natural-language question or keywords'),
      product_code: z.string().optional().describe('Restrict to one product, e.g. TRM-20'),
      limit: z.number().int().min(1).max(10).optional().describe('Max results, default 3'),
    },
  },
  async ({ query: searchText, product_code, limit = 3 }) => {
    const embedding = toVectorLiteral(await embed(searchText));
    // Hybrid retrieval via Reciprocal Rank Fusion. Vector similarity catches paraphrase,
    // full-text catches exact domain terms ("paramedical", "contestability"); either alone
    // misranks on this corpus. RRF combines the two *rankings* rather than their scores,
    // which matters because cosine similarity and ts_rank_cd live on incomparable scales —
    // weighting the raw scores lets whichever one happens to be larger dominate.
    const rows = await query(
      `WITH filtered AS (
         SELECT * FROM policy_documents
          WHERE ($3::text IS NULL OR product_code = $3)
       ),
       -- websearch_to_tsquery ANDs every term, so a full-sentence question matches no
       -- document and the hybrid search silently collapses to vector-only. Rewriting the
       -- operators to OR makes the lexical side rank by how many query terms a document
       -- contains, which is what we want as one half of a fusion.
       q AS (
         SELECT replace(websearch_to_tsquery('english', $2)::text, '&', '|')::tsquery AS tsq
       ),
       vector_ranked AS (
         SELECT doc_id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
           FROM filtered
       ),
       text_ranked AS (
         SELECT doc_id,
                ROW_NUMBER() OVER (ORDER BY ts_rank_cd(content_tsv, (SELECT tsq FROM q)) DESC) AS rank
           FROM filtered
          WHERE content_tsv @@ (SELECT tsq FROM q)
       )
       SELECT f.doc_id, f.title, f.doc_type, f.product_code, f.content,
              v.rank AS vector_rank,
              t.rank AS text_rank,
              COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + t.rank), 0) AS score
         FROM filtered f
         LEFT JOIN vector_ranked v ON v.doc_id = f.doc_id
         LEFT JOIN text_ranked   t ON t.doc_id = f.doc_id
        ORDER BY score DESC,
                 -- RRF ties are common and exact: a document ranked (1,2) scores identically to
                 -- one ranked (2,1). Without a tie-break Postgres returns whichever the plan
                 -- happens to emit first, so the same query can give different answers in
                 -- different contexts. Prefer the better vector rank — with a real embedding
                 -- model that is the semantic signal, and full-text is the safety net — then
                 -- doc_id, so the order is fully determined.
                 COALESCE(v.rank, 2147483647),
                 f.doc_id
        LIMIT $4`,
      [embedding, searchText, product_code ?? null, limit],
    );

    if (rows.length === 0) return text('No matching documents.');

    return text(
      rows.map((row) => ({
        doc_id: row.doc_id,
        title: row.title,
        doc_type: row.doc_type,
        product_code: row.product_code,
        score: Number(Number(row.score).toFixed(5)),
        vector_rank: row.vector_rank,
        text_rank: row.text_rank, // null when the document matched no query term

        excerpt: row.content.length > 600 ? `${row.content.slice(0, 600)}…` : row.content,
      })),
    );
  },
);

server.registerTool(
  'get_application_status',
  {
    title: 'Get application status',
    description:
      'Look up a life insurance application by its number and return current status, the step it is ' +
      'waiting on, the assigned underwriter, and the full event timeline.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      application_number: z.string().describe('Application number, e.g. APP-100242'),
    },
  },
  async ({ application_number }) => {
    const [application] = await query(
      `SELECT a.*, p.name AS product_name, p.product_type
         FROM applications a
         JOIN products p USING (product_code)
        WHERE a.application_number = $1`,
      [application_number],
    );

    if (!application) return text(`No application found with number ${application_number}.`);

    const events = await query(
      `SELECT occurred_at, event, detail
         FROM application_events
        WHERE application_number = $1
        ORDER BY occurred_at`,
      [application_number],
    );

    return text({ ...application, timeline: events });
  },
);

server.registerTool(
  'lookup_product_rules',
  {
    title: 'Look up product rules',
    description:
      'Return a product’s issue limits and underwriting rules. When applicant_age, face_amount or ' +
      'state are supplied, also evaluates hard eligibility and flags which rules would trigger.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      product_code: z.string().describe('Product code, e.g. UL-200'),
      applicant_age: z.number().int().min(0).max(120).optional(),
      face_amount: z.number().int().positive().optional(),
      state: z.string().length(2).optional().describe('Two-letter state code'),
    },
  },
  async ({ product_code, applicant_age, face_amount, state }) => {
    const [product] = await query('SELECT * FROM products WHERE product_code = $1', [product_code]);
    if (!product) {
      const available = await query('SELECT product_code, name FROM products ORDER BY product_code');
      return text({ error: `Unknown product ${product_code}`, available });
    }

    const rules = await query(
      'SELECT rule_code, category, description, condition, outcome FROM underwriting_rules WHERE product_code = $1 ORDER BY rule_code',
      [product_code],
    );

    const response = { product, rules };

    // Only assert eligibility on the dimensions the caller actually gave us.
    if (applicant_age !== undefined || face_amount !== undefined || state !== undefined) {
      const failures = [];
      if (applicant_age !== undefined) {
        if (applicant_age < product.min_issue_age || applicant_age > product.max_issue_age) {
          failures.push(
            `Issue age ${applicant_age} is outside ${product.min_issue_age}–${product.max_issue_age}.`,
          );
        }
      }
      if (face_amount !== undefined) {
        if (face_amount < Number(product.min_face_amount) || face_amount > Number(product.max_face_amount)) {
          failures.push(
            `Face amount ${face_amount} is outside ${product.min_face_amount}–${product.max_face_amount}.`,
          );
        }
      }
      if (state !== undefined && !product.available_states.includes(state.toUpperCase())) {
        failures.push(`Product is not filed in ${state.toUpperCase()}.`);
      }

      response.eligibility = {
        eligible: failures.length === 0,
        failures,
        evaluated_on: {
          applicant_age: applicant_age ?? null,
          face_amount: face_amount ?? null,
          state: state ?? null,
        },
        note: 'Only the supplied fields were evaluated. Rules below are reported as text for the agent to reason over; this POC does not execute them.',
      };
    }

    return text(response);
  },
);

server.registerTool(
  'find_applications',
  {
    title: 'Find applications',
    description:
      'Search the pipeline. Filter by status, product, underwriter, or state, and by how long a case ' +
      'has sat without movement. Use this for questions about the book of business as a whole — ' +
      '"what is stuck", "what is this underwriter carrying" — rather than one known application.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      status: z.string().optional().describe('e.g. pending_underwriting, referred, approved'),
      product_code: z.string().optional(),
      underwriter: z.string().optional().describe('Assigned underwriter name'),
      state: z.string().length(2).optional(),
      stalled_days_min: z.number().int().min(0).optional().describe('Only cases untouched for at least this many days'),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ status, product_code, underwriter, state, stalled_days_min, limit = 20 }) => {
    const rows = await query(
      `SELECT application_number, applicant_name, applicant_age, applicant_state, product_code,
              face_amount, status, current_step, assigned_underwriter,
              EXTRACT(DAY FROM now() - updated_at)::int AS days_since_update
         FROM applications
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR product_code = $2)
          AND ($3::text IS NULL OR assigned_underwriter = $3)
          AND ($4::text IS NULL OR applicant_state = upper($4))
          AND ($5::int  IS NULL OR now() - updated_at >= make_interval(days => $5))
        ORDER BY updated_at
        LIMIT $6`,
      [status ?? null, product_code ?? null, underwriter ?? null, state ?? null, stalled_days_min ?? null, limit],
    );

    return text({ count: rows.length, applications: rows });
  },
);

server.registerTool(
  'get_outstanding_requirements',
  {
    title: 'Get outstanding requirements',
    description:
      'Outstanding requirements with how long each has been open, and the follow-up action the ' +
      'new-business procedure calls for at that age. Answers "why is this case not moving" and ' +
      '"what needs chasing today".',
    annotations: { readOnlyHint: true },
    inputSchema: {
      application_number: z.string().optional().describe('Omit to sweep the whole pipeline'),
      overdue_only: z.boolean().optional().describe('Only requirements past the 14-day first follow-up'),
    },
  },
  async ({ application_number, overdue_only = false }) => {
    const rows = await query(
      `SELECT r.application_number, a.applicant_name, r.requirement_code, r.description, r.vendor,
              r.ordered_at, EXTRACT(DAY FROM now() - r.ordered_at)::int AS days_outstanding
         FROM requirements r
         JOIN applications a USING (application_number)
        WHERE r.status = 'outstanding'
          AND ($1::text IS NULL OR r.application_number = $1)
        ORDER BY r.ordered_at`,
      [application_number ?? null],
    );

    // Thresholds come from PROC-REQ-01; kept here so the agent gets the action, not just a number.
    const withAction = rows.map((row) => {
      const days = row.days_outstanding;
      let follow_up_stage;
      let action;
      if (days >= 90) {
        follow_up_stage = 'past_90_days';
        action = 'Close as incomplete; a new application is required.';
      } else if (days >= 28) {
        follow_up_stage = 'second_follow_up';
        action = 'Escalate to the case manager.';
      } else if (days >= 14) {
        follow_up_stage = 'first_follow_up';
        action = 'System notice to the ordering vendor and the writing agent.';
      } else {
        follow_up_stage = 'within_first_cycle';
        action = 'No action yet; first follow-up falls due at 14 days.';
      }
      return { ...row, follow_up_stage, action };
    });

    const filtered = overdue_only ? withAction.filter((row) => row.days_outstanding >= 14) : withAction;
    return text({ count: filtered.length, requirements: filtered });
  },
);

server.registerTool(
  'find_eligible_products',
  {
    title: 'Find eligible products',
    description:
      'Given an applicant, return every product they can actually be issued, with the rules that ' +
      'would fire. This is the distribution-side question — "what can I sell this person" — and is ' +
      'the inverse of lookup_product_rules, which starts from a product you already picked.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      applicant_age: z.number().int().min(0).max(120),
      face_amount: z.number().int().positive(),
      state: z.string().length(2),
    },
  },
  async ({ applicant_age, face_amount, state }) => {
    const products = await query(
      `SELECT * FROM products WHERE active ORDER BY product_code`,
    );

    const eligible = [];
    const ineligible = [];

    for (const product of products) {
      const reasons = [];
      if (applicant_age < product.min_issue_age || applicant_age > product.max_issue_age) {
        reasons.push(`issue age outside ${product.min_issue_age}–${product.max_issue_age}`);
      }
      if (face_amount < Number(product.min_face_amount) || face_amount > Number(product.max_face_amount)) {
        reasons.push(`face amount outside ${product.min_face_amount}–${product.max_face_amount}`);
      }
      if (!product.available_states.includes(state.toUpperCase())) {
        reasons.push(`not filed in ${state.toUpperCase()}`);
      }

      const entry = { product_code: product.product_code, name: product.name, product_type: product.product_type };
      if (reasons.length) {
        ineligible.push({ ...entry, reasons });
      } else {
        const rules = await query(
          'SELECT rule_code, description, outcome FROM underwriting_rules WHERE product_code = $1 ORDER BY rule_code',
          [product.product_code],
        );
        eligible.push({ ...entry, rules_to_review: rules });
      }
    }

    return text({
      applicant: { applicant_age, face_amount, state: state.toUpperCase() },
      eligible,
      ineligible,
      note: 'Eligibility here covers hard limits only — age band, face band and state filing. The listed rules still need underwriter review.',
    });
  },
);

server.registerTool(
  'estimate_premium',
  {
    title: 'Estimate premium',
    description:
      'Indicative annual and monthly premium from the rate table, for a product, age and risk class. ' +
      'Rates are per $1,000 of face amount. This is an illustration, not an offer — the risk class is ' +
      'an assumption until underwriting completes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      product_code: z.string(),
      applicant_age: z.number().int().min(0).max(120),
      face_amount: z.number().int().positive(),
      risk_class: z
        .enum(['preferred_plus', 'preferred', 'standard', 'table_b', 'table_d'])
        .optional()
        .describe('Defaults to standard'),
    },
  },
  async ({ product_code, applicant_age, face_amount, risk_class = 'standard' }) => {
    const [rate] = await query(
      `SELECT annual_rate_per_1000, age_min, age_max
         FROM rate_tables
        WHERE product_code = $1 AND risk_class = $2 AND $3 BETWEEN age_min AND age_max`,
      [product_code, risk_class, applicant_age],
    );

    if (!rate) {
      const available = await query(
        'SELECT DISTINCT risk_class, age_min, age_max FROM rate_tables WHERE product_code = $1 ORDER BY age_min',
        [product_code],
      );
      return text({
        error: `No rate for ${product_code} / ${risk_class} / age ${applicant_age}.`,
        available_bands: available,
      });
    }

    const POLICY_FEE = 60;
    const annualRate = Number(rate.annual_rate_per_1000);
    const annualPremium = (face_amount / 1000) * annualRate + POLICY_FEE;

    return text({
      product_code,
      applicant_age,
      face_amount,
      risk_class,
      rate_per_1000: annualRate,
      age_band: `${rate.age_min}–${rate.age_max}`,
      annual_premium: Number(annualPremium.toFixed(2)),
      monthly_premium: Number((annualPremium / 12).toFixed(2)),
      policy_fee_included: POLICY_FEE,
      disclaimer: 'Indicative only. Final premium depends on the risk class assigned at underwriting.',
    });
  },
);

server.registerTool(
  'get_underwriter_workload',
  {
    title: 'Get underwriter workload',
    description:
      'Open case count, total face amount at risk, and the oldest untouched case per underwriter. ' +
      'Use for triage and reassignment questions.',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  async () => {
    const rows = await query(
      `SELECT assigned_underwriter,
              COUNT(*) FILTER (WHERE status NOT IN ('approved', 'declined')) AS open_cases,
              COUNT(*) AS total_cases,
              COALESCE(SUM(face_amount) FILTER (WHERE status NOT IN ('approved', 'declined')), 0) AS open_face_amount,
              MAX(EXTRACT(DAY FROM now() - updated_at))::int AS oldest_untouched_days
         FROM applications
        WHERE assigned_underwriter IS NOT NULL
        GROUP BY assigned_underwriter
        ORDER BY open_cases DESC`,
    );

    return text({ underwriters: rows });
  },
);

server.registerTool(
  'add_case_note',
  {
    title: 'Add case note',
    description:
      'Append a note to an application timeline. This is the only tool here that writes — it adds a ' +
      'record, never edits or removes one, so a mistaken call is additive rather than destructive.',
    // Explicitly not read-only, and flagged non-idempotent: calling twice writes two notes.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      application_number: z.string(),
      note: z.string().min(1).max(2000),
      author: z.string().describe('Who the note is recorded as — an underwriter or system name'),
    },
  },
  async ({ application_number, note, author }) => {
    const [application] = await query(
      'SELECT application_number FROM applications WHERE application_number = $1',
      [application_number],
    );
    if (!application) return text(`No application found with number ${application_number}. Nothing was written.`);

    const [event] = await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'note', $2)
       RETURNING id, application_number, occurred_at, event, detail`,
      [application_number, `${author}: ${note}`],
    );

    return text({ written: true, event });
  },
);

server.registerTool(
  'find_applicant',
  {
    title: 'Find applicant',
    description:
      'Find applications by applicant name, whole or partial. Use this first when someone is named ' +
      'but no application number is given — every other case tool needs the number, and this is how ' +
      'you get it.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      name: z.string().min(2).describe('Full or partial name, case-insensitive'),
      limit: z.number().int().min(1).max(25).optional(),
    },
  },
  async ({ name, limit = 10 }) => {
    const rows = await query(
      `SELECT application_number, applicant_name, applicant_age, applicant_state,
              product_code, face_amount, status, current_step, assigned_underwriter
         FROM applications
        WHERE applicant_name ILIKE '%' || $1 || '%'
        ORDER BY applicant_name
        LIMIT $2`,
      [name, limit],
    );

    if (rows.length === 0) return text(`No applicant matching "${name}".`);
    return text({ count: rows.length, matches: rows });
  },
);

server.registerTool(
  'list_documents',
  {
    title: 'List documents',
    description:
      'Enumerate the document corpus by product or type, without searching. Use when the question is ' +
      '"what guidance exists for this product" rather than "what does it say" — or when a search ' +
      'came back empty and you need to see what is actually available.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      product_code: z.string().optional(),
      doc_type: z
        .enum(['contract', 'rider', 'underwriting_guideline', 'disclosure', 'procedure'])
        .optional(),
    },
  },
  async ({ product_code, doc_type }) => {
    const rows = await query(
      `SELECT doc_id, title, doc_type, product_code, length(content) AS length_chars
         FROM policy_documents
        WHERE ($1::text IS NULL OR product_code = $1)
          AND ($2::text IS NULL OR doc_type = $2)
        ORDER BY doc_type, doc_id`,
      [product_code ?? null, doc_type ?? null],
    );

    return text({ count: rows.length, documents: rows });
  },
);

server.registerTool(
  'get_rate_card',
  {
    title: 'Get rate card',
    description:
      'The full rate table for a product — every risk class and age band. Use when comparing classes ' +
      'or explaining how a premium was derived; use estimate_premium when you want one number.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      product_code: z.string(),
      risk_class: z.enum(['preferred_plus', 'preferred', 'standard', 'table_b', 'table_d']).optional(),
    },
  },
  async ({ product_code, risk_class }) => {
    const rows = await query(
      `SELECT risk_class, age_min, age_max, annual_rate_per_1000
         FROM rate_tables
        WHERE product_code = $1
          AND ($2::text IS NULL OR risk_class = $2)
        ORDER BY age_min, risk_class`,
      [product_code, risk_class ?? null],
    );

    if (rows.length === 0) return text(`No rate card for ${product_code}.`);
    return text({ product_code, bands: rows, units: 'annual premium per $1,000 of face amount' });
  },
);

server.registerTool(
  'get_pipeline_metrics',
  {
    title: 'Get pipeline metrics',
    description:
      'Health of the book: case counts and face amount by status, and outstanding requirements ' +
      'bucketed by age against the 14 / 28 / 90 day follow-up thresholds. Use for "how are we doing" ' +
      'questions rather than anything about a specific case.',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  async () => {
    const byStatus = await query(
      `SELECT status, COUNT(*)::int AS cases, SUM(face_amount)::bigint AS face_amount,
              ROUND(AVG(EXTRACT(DAY FROM now() - submitted_at)))::int AS avg_days_since_submission
         FROM applications
        GROUP BY status
        ORDER BY cases DESC`,
    );

    const requirementAging = await query(
      `SELECT CASE
                WHEN now() - ordered_at >= interval '90 days' THEN 'past_90_days'
                WHEN now() - ordered_at >= interval '28 days' THEN 'second_follow_up'
                WHEN now() - ordered_at >= interval '14 days' THEN 'first_follow_up'
                ELSE 'within_first_cycle'
              END AS bucket,
              COUNT(*)::int AS requirements
         FROM requirements
        WHERE status = 'outstanding'
        GROUP BY bucket`,
    );

    const [totals] = await query(
      `SELECT COUNT(*)::int AS total_applications,
              COUNT(*) FILTER (WHERE status NOT IN ('approved', 'declined'))::int AS open_applications,
              SUM(face_amount) FILTER (WHERE status NOT IN ('approved', 'declined'))::bigint AS open_face_amount
         FROM applications`,
    );

    return text({ totals, by_status: byStatus, outstanding_requirement_aging: requirementAging });
  },
);

server.registerTool(
  'update_requirement_status',
  {
    title: 'Update requirement status',
    description:
      'Mark an outstanding requirement as received or waived. Records the change on the application ' +
      'timeline as well. Setting a requirement to the state it is already in is a no-op.',
    // Edits an existing row rather than appending, but re-applying the same value changes nothing,
    // so this is idempotent — unlike add_case_note.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      application_number: z.string(),
      requirement_code: z.string().describe('e.g. APS, PARAMED, MVR'),
      status: z.enum(['received', 'waived']),
      note: z.string().max(500).optional().describe('Optional context for the timeline entry'),
    },
  },
  async ({ application_number, requirement_code, status, note }) => {
    const [existing] = await query(
      'SELECT id, status FROM requirements WHERE application_number = $1 AND requirement_code = $2',
      [application_number, requirement_code],
    );

    if (!existing) {
      return text(
        `No requirement ${requirement_code} on ${application_number}. Nothing was changed.`,
      );
    }
    if (existing.status === status) {
      return text({ changed: false, reason: `Already ${status}.`, requirement_code, application_number });
    }

    const [updated] = await query(
      `UPDATE requirements
          SET status = $1, received_at = CASE WHEN $1 = 'received' THEN now() ELSE received_at END
        WHERE id = $2
        RETURNING application_number, requirement_code, status, received_at`,
      [status, existing.id],
    );

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'requirement_updated', $2)`,
      [application_number, `${requirement_code} marked ${status}${note ? ` — ${note}` : ''}`],
    );

    return text({ changed: true, previous_status: existing.status, requirement: updated });
  },
);

server.registerTool(
  'reassign_application',
  {
    title: 'Reassign application',
    description:
      'Move a case to a different underwriter and record why. Use for triage after checking ' +
      'get_underwriter_workload. Overwrites the current assignment, so confirm the intent before ' +
      'calling.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      application_number: z.string(),
      to_underwriter: z.string().describe('Name of the receiving underwriter'),
      reason: z.string().min(1).max(500),
    },
  },
  async ({ application_number, to_underwriter, reason }) => {
    const [application] = await query(
      'SELECT assigned_underwriter FROM applications WHERE application_number = $1',
      [application_number],
    );
    if (!application) return text(`No application found with number ${application_number}. Nothing was changed.`);

    if (application.assigned_underwriter === to_underwriter) {
      return text({ changed: false, reason: `Already assigned to ${to_underwriter}.`, application_number });
    }

    await query(
      'UPDATE applications SET assigned_underwriter = $1, updated_at = now() WHERE application_number = $2',
      [to_underwriter, application_number],
    );

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'reassigned', $2)`,
      [application_number, `Reassigned from ${application.assigned_underwriter ?? 'unassigned'} to ${to_underwriter} — ${reason}`],
    );

    return text({
      changed: true,
      application_number,
      previous_underwriter: application.assigned_underwriter,
      new_underwriter: to_underwriter,
      reason,
    });
  },
);

server.registerTool(
  'get_document',
  {
    title: 'Get document',
    description:
      'Retrieve one document in full by its doc_id. search_policy_documents truncates excerpts, so ' +
      'use this when the exact wording matters — quoting a clause, checking a condition, or reading ' +
      'past where an excerpt cut off. Get the doc_id from search_policy_documents or list_documents.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      doc_id: z.string().describe('e.g. TRM20-CONTRACT-02'),
    },
  },
  async ({ doc_id }) => {
    const [document] = await query(
      `SELECT d.doc_id, d.title, d.doc_type, d.product_code, d.content,
              p.name AS product_name
         FROM policy_documents d
         LEFT JOIN products p USING (product_code)
        WHERE d.doc_id = $1`,
      [doc_id],
    );

    if (!document) {
      const nearby = await query(
        'SELECT doc_id, title FROM policy_documents ORDER BY doc_id LIMIT 20',
      );
      return text({ error: `No document with doc_id ${doc_id}.`, available: nearby });
    }

    // Rules for the same product are what a reader of a guideline usually needs next.
    const relatedRules = document.product_code
      ? await query(
          'SELECT rule_code, description, outcome FROM underwriting_rules WHERE product_code = $1 ORDER BY rule_code',
          [document.product_code],
        )
      : [];

    return text({ ...document, related_rules: relatedRules });
  },
);

server.registerTool(
  'order_requirement',
  {
    title: 'Order a requirement',
    description:
      'Order a new requirement on an application — an exam, an attending physician statement, a ' +
      'financial supplement. Completes the other half of update_requirement_status, which can only ' +
      'close requirements that already exist. Ordering one that is already outstanding is a no-op.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      application_number: z.string(),
      requirement_code: z.string().min(2).max(20).describe('Short code, e.g. APS, PARAMED, MVR, FINSUPP'),
      description: z.string().min(3).max(300),
      vendor: z.string().max(100).optional().describe('Who is fulfilling it, if anyone'),
    },
  },
  async ({ application_number, requirement_code, description, vendor }) => {
    const [application] = await query(
      'SELECT application_number FROM applications WHERE application_number = $1',
      [application_number],
    );
    if (!application) return text(`No application found with number ${application_number}. Nothing was ordered.`);

    const [duplicate] = await query(
      `SELECT id FROM requirements
        WHERE application_number = $1 AND requirement_code = $2 AND status = 'outstanding'`,
      [application_number, requirement_code],
    );
    if (duplicate) {
      return text({
        ordered: false,
        reason: `${requirement_code} is already outstanding on ${application_number}.`,
      });
    }

    const [requirement] = await query(
      `INSERT INTO requirements (application_number, requirement_code, description, vendor, ordered_at, status)
       VALUES ($1, $2, $3, $4, now(), 'outstanding')
       RETURNING id, application_number, requirement_code, description, vendor, ordered_at, status`,
      [application_number, requirement_code, description, vendor ?? null],
    );

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'requirement_ordered', $2)`,
      [application_number, `${requirement_code} ordered${vendor ? ` from ${vendor}` : ''} — ${description}`],
    );

    return text({ ordered: true, requirement });
  },
);

server.registerTool(
  'record_underwriting_decision',
  {
    title: 'Record an underwriting decision',
    description:
      'Record the outcome of underwriting on an application: approved, declined, referred, or ' +
      'approved with a rating. Updates the case status and writes the reason to the timeline. ' +
      'Approval is refused while requirements are still outstanding — resolve those first with ' +
      'update_requirement_status.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      application_number: z.string(),
      decision: z.enum(['approved', 'declined', 'referred', 'approved_rated']),
      reason: z.string().min(3).max(500).describe('Why — recorded verbatim on the timeline'),
      risk_class: z
        .enum(['preferred_plus', 'preferred', 'standard', 'table_b', 'table_d'])
        .optional()
        .describe('Required when the decision is approved_rated'),
    },
  },
  async ({ application_number, decision, reason, risk_class }) => {
    const [application] = await query(
      'SELECT status, current_step FROM applications WHERE application_number = $1',
      [application_number],
    );
    if (!application) return text(`No application found with number ${application_number}. Nothing was changed.`);

    if (application.status === decision) {
      return text({ changed: false, reason: `Already ${decision}.`, application_number });
    }

    if (decision === 'approved_rated' && !risk_class) {
      return text({
        changed: false,
        reason: 'approved_rated requires a risk_class. Nothing was changed.',
      });
    }

    // A domain guardrail, not a schema one: no schema can express "approval is invalid while
    // evidence is outstanding", because it depends on other rows.
    if (decision === 'approved' || decision === 'approved_rated') {
      const outstanding = await query(
        `SELECT requirement_code, description FROM requirements
          WHERE application_number = $1 AND status = 'outstanding' ORDER BY ordered_at`,
        [application_number],
      );
      if (outstanding.length > 0) {
        return text({
          changed: false,
          reason: `Cannot approve while ${outstanding.length} requirement(s) remain outstanding.`,
          outstanding,
          next_step: 'Resolve each with update_requirement_status, then record the decision again.',
        });
      }
    }

    const STEP = {
      approved: 'pending_issue',
      approved_rated: 'pending_offer_acceptance',
      declined: 'closed',
      referred: 'senior_review',
    };

    await query(
      'UPDATE applications SET status = $1, current_step = $2, updated_at = now() WHERE application_number = $3',
      [decision, STEP[decision], application_number],
    );

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'decision_recorded', $2)`,
      [application_number, `${decision}${risk_class ? ` at ${risk_class}` : ''} — ${reason}`],
    );

    return text({
      changed: true,
      application_number,
      previous_status: application.status,
      decision,
      risk_class: risk_class ?? null,
      current_step: STEP[decision],
    });
  },
);

server.registerTool(
  'compare_products',
  {
    title: 'Compare products',
    description:
      'For one applicant, return every product they can be issued with its premium, cheapest first, ' +
      'plus the products they fail and why. Prefer this over calling find_eligible_products and then ' +
      'estimate_premium once per product — it answers "what are the options and what do they cost" ' +
      'in a single call.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      applicant_age: z.number().int().min(0).max(120),
      face_amount: z.number().int().positive(),
      state: z.string().length(2),
      risk_class: z
        .enum(['preferred_plus', 'preferred', 'standard', 'table_b', 'table_d'])
        .optional()
        .describe('Assumed class for pricing; defaults to standard'),
    },
  },
  async ({ applicant_age, face_amount, state, risk_class = 'standard' }) => {
    const POLICY_FEE = 60;
    const products = await query('SELECT * FROM products WHERE active ORDER BY product_code');

    const options = [];
    const unavailable = [];

    for (const product of products) {
      const reasons = [];
      if (applicant_age < product.min_issue_age || applicant_age > product.max_issue_age) {
        reasons.push(`issue age outside ${product.min_issue_age}–${product.max_issue_age}`);
      }
      if (face_amount < Number(product.min_face_amount) || face_amount > Number(product.max_face_amount)) {
        reasons.push(`face amount outside ${product.min_face_amount}–${product.max_face_amount}`);
      }
      if (!product.available_states.includes(state.toUpperCase())) {
        reasons.push(`not filed in ${state.toUpperCase()}`);
      }

      if (reasons.length) {
        unavailable.push({ product_code: product.product_code, name: product.name, reasons });
        continue;
      }

      const [rate] = await query(
        `SELECT annual_rate_per_1000 FROM rate_tables
          WHERE product_code = $1 AND risk_class = $2 AND $3 BETWEEN age_min AND age_max`,
        [product.product_code, risk_class, applicant_age],
      );

      if (!rate) {
        // Eligible to be issued, but this class is not priced at this age — a real distinction,
        // so it is reported rather than silently dropped or shown as free.
        options.push({
          product_code: product.product_code,
          name: product.name,
          product_type: product.product_type,
          annual_premium: null,
          note: `No ${risk_class} rate band at age ${applicant_age}; eligible but unpriced.`,
        });
        continue;
      }

      const annual = (face_amount / 1000) * Number(rate.annual_rate_per_1000) + POLICY_FEE;
      options.push({
        product_code: product.product_code,
        name: product.name,
        product_type: product.product_type,
        rate_per_1000: Number(rate.annual_rate_per_1000),
        annual_premium: Number(annual.toFixed(2)),
        monthly_premium: Number((annual / 12).toFixed(2)),
      });
    }

    options.sort((a, b) => (a.annual_premium ?? Infinity) - (b.annual_premium ?? Infinity));

    return text({
      applicant: { applicant_age, face_amount, state: state.toUpperCase(), assumed_risk_class: risk_class },
      options,
      unavailable,
      disclaimer: 'Premiums are indicative. The risk class is an assumption until underwriting completes.',
    });
  },
);

server.registerTool(
  'create_application',
  {
    title: 'Create an application',
    description:
      'Submit a new application and return its number. This is the entry point to the pipeline — ' +
      'every other case tool needs an application that already exists. The product must actually be ' +
      'issuable to this applicant; hard limits are checked before anything is written.',
    // Not idempotent, and importantly so: two calls create two applications for the same person.
    // There is no natural key to deduplicate on, so the caller must mean it.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      applicant_name: z.string().min(2).max(120),
      applicant_age: z.number().int().min(0).max(120),
      applicant_state: z.string().length(2).describe('Two-letter state code'),
      product_code: z.string(),
      face_amount: z.number().int().positive(),
      assigned_underwriter: z.string().max(80).optional().describe('Leave empty to submit unassigned'),
    },
  },
  async ({ applicant_name, applicant_age, applicant_state, product_code, face_amount, assigned_underwriter }) => {
    const [product] = await query('SELECT * FROM products WHERE product_code = $1', [product_code]);
    if (!product) {
      const available = await query('SELECT product_code, name FROM products WHERE active ORDER BY product_code');
      return text({ created: false, error: `Unknown product ${product_code}.`, available });
    }
    if (!product.active) {
      return text({ created: false, error: `${product_code} is no longer open for new business.` });
    }

    const state = applicant_state.toUpperCase();
    const failures = [];
    if (applicant_age < product.min_issue_age || applicant_age > product.max_issue_age) {
      failures.push(`issue age ${applicant_age} is outside ${product.min_issue_age}-${product.max_issue_age}`);
    }
    if (face_amount < Number(product.min_face_amount) || face_amount > Number(product.max_face_amount)) {
      failures.push(`face amount ${face_amount} is outside ${product.min_face_amount}-${product.max_face_amount}`);
    }
    if (!product.available_states.includes(state)) {
      failures.push(`${product_code} is not filed in ${state}`);
    }
    if (failures.length) {
      return text({
        created: false,
        reason: `${product_code} cannot be issued to this applicant. Nothing was written.`,
        failures,
        next_step: 'Call compare_products with the same applicant to see what can be issued.',
      });
    }

    const [next] = await query(
      `SELECT 'APP-' || (COALESCE(MAX(substring(application_number from 5)::int), 100240) + 1)::text AS number
         FROM applications
        WHERE application_number ~ '^APP-[0-9]+$'`,
    );

    const [application] = await query(
      `INSERT INTO applications
         (application_number, applicant_name, applicant_age, applicant_state, product_code,
          face_amount, status, current_step, assigned_underwriter, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_underwriting', 'awaiting_triage', $7, now(), now())
       RETURNING application_number, applicant_name, product_code, face_amount, status, current_step,
                 assigned_underwriter, submitted_at`,
      [next.number, applicant_name, applicant_age, state, product_code, face_amount, assigned_underwriter ?? null],
    );

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'submitted', $2)`,
      [next.number, `Application created for ${applicant_name}, ${product_code}, face amount ${face_amount}`],
    );

    // Rules are reported rather than executed, same as everywhere else in this server.
    const rules = await query(
      'SELECT rule_code, description, outcome FROM underwriting_rules WHERE product_code = $1 ORDER BY rule_code',
      [product_code],
    );

    return text({ created: true, application, rules_to_review: rules });
  },
);

server.registerTool(
  'withdraw_application',
  {
    title: 'Withdraw an application',
    description:
      'Close a case the applicant or agent has abandoned. This is distinct from ' +
      'record_underwriting_decision: withdrawal comes from the customer side and is not an ' +
      'underwriting outcome. A case that has already been decided cannot be withdrawn.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      application_number: z.string(),
      reason: z.string().min(3).max(500),
      withdrawn_by: z.string().max(80).optional().describe('Applicant, agent, or whoever requested it'),
    },
  },
  async ({ application_number, reason, withdrawn_by }) => {
    const [application] = await query(
      'SELECT status, current_step FROM applications WHERE application_number = $1',
      [application_number],
    );
    if (!application) return text(`No application found with number ${application_number}. Nothing was changed.`);

    if (application.status === 'withdrawn') {
      return text({ changed: false, reason: 'Already withdrawn.', application_number });
    }

    const DECIDED = ['approved', 'approved_rated', 'declined'];
    if (DECIDED.includes(application.status)) {
      return text({
        changed: false,
        reason: `${application_number} is already ${application.status}; a decided case cannot be withdrawn.`,
        next_step: 'Record the outcome on the timeline with add_case_note instead.',
      });
    }

    await query(
      `UPDATE applications SET status = 'withdrawn', current_step = 'closed', updated_at = now()
        WHERE application_number = $1`,
      [application_number],
    );

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'withdrawn', $2)`,
      [application_number, `Withdrawn${withdrawn_by ? ` by ${withdrawn_by}` : ''} - ${reason}`],
    );

    // Outstanding requirements are left as-is rather than cancelled: vendors may already have
    // been engaged, and the record of what was ordered is worth keeping.
    const stranded = await query(
      `SELECT requirement_code FROM requirements WHERE application_number = $1 AND status = 'outstanding'`,
      [application_number],
    );

    return text({
      changed: true,
      application_number,
      previous_status: application.status,
      status: 'withdrawn',
      requirements_left_outstanding: stranded.map((r) => r.requirement_code),
    });
  },
);

server.registerTool(
  'amend_application',
  {
    title: 'Amend an application',
    description:
      'Change the face amount or product on an in-flight application. Applicants revise how much ' +
      'cover they want more often than anything else, and the amended figure has to be re-checked ' +
      'against the product limits — an increase can push a case outside what the product allows, or ' +
      'across a threshold that changes which rules apply. Decided and withdrawn cases cannot be ' +
      'amended.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      application_number: z.string(),
      face_amount: z.number().int().positive().optional(),
      product_code: z.string().optional().describe('Move the case to a different product'),
      reason: z.string().min(3).max(500),
    },
  },
  async ({ application_number, face_amount, product_code, reason }) => {
    if (face_amount === undefined && product_code === undefined) {
      return text({
        changed: false,
        reason: 'Supply face_amount or product_code (or both). Nothing was changed.',
      });
    }

    const [application] = await query(
      `SELECT application_number, applicant_age, applicant_state, product_code, face_amount, status
         FROM applications WHERE application_number = $1`,
      [application_number],
    );
    if (!application) return text(`No application found with number ${application_number}. Nothing was changed.`);

    const CLOSED = ['approved', 'approved_rated', 'declined', 'withdrawn'];
    if (CLOSED.includes(application.status)) {
      return text({
        changed: false,
        reason: `${application_number} is ${application.status}; a closed case cannot be amended.`,
        next_step: 'Create a new application with create_application if the applicant wants different cover.',
      });
    }

    const targetProduct = product_code ?? application.product_code;
    const targetFace = face_amount ?? Number(application.face_amount);

    if (targetProduct === application.product_code && targetFace === Number(application.face_amount)) {
      return text({
        changed: false,
        reason: 'The amendment matches the current values.',
        application_number,
      });
    }

    const [product] = await query('SELECT * FROM products WHERE product_code = $1', [targetProduct]);
    if (!product) {
      const available = await query('SELECT product_code, name FROM products WHERE active ORDER BY product_code');
      return text({ changed: false, error: `Unknown product ${targetProduct}.`, available });
    }
    if (!product.active) {
      return text({ changed: false, error: `${targetProduct} is no longer open for new business.` });
    }

    // The applicant's age and state are fixed facts on the case; only the requested cover moves.
    const failures = [];
    if (application.applicant_age < product.min_issue_age || application.applicant_age > product.max_issue_age) {
      failures.push(`issue age ${application.applicant_age} is outside ${product.min_issue_age}-${product.max_issue_age} for ${targetProduct}`);
    }
    if (targetFace < Number(product.min_face_amount) || targetFace > Number(product.max_face_amount)) {
      failures.push(`face amount ${targetFace} is outside ${product.min_face_amount}-${product.max_face_amount} for ${targetProduct}`);
    }
    if (!product.available_states.includes(application.applicant_state)) {
      failures.push(`${targetProduct} is not filed in ${application.applicant_state}`);
    }
    if (failures.length) {
      return text({
        changed: false,
        reason: 'The amended case would not be issuable. Nothing was changed.',
        failures,
        next_step: 'Call compare_products with this applicant to see what the new figure allows.',
      });
    }

    await query(
      `UPDATE applications
          SET product_code = $1, face_amount = $2, updated_at = now()
        WHERE application_number = $3`,
      [targetProduct, targetFace, application_number],
    );

    const detail =
      `Amended: ` +
      [
        targetProduct !== application.product_code ? `product ${application.product_code} -> ${targetProduct}` : null,
        targetFace !== Number(application.face_amount) ? `face amount ${application.face_amount} -> ${targetFace}` : null,
      ]
        .filter(Boolean)
        .join(', ') +
      ` - ${reason}`;

    await query(
      `INSERT INTO application_events (application_number, occurred_at, event, detail)
       VALUES ($1, now(), 'amended', $2)`,
      [application_number, detail],
    );

    // Reported, not executed — same as everywhere else in this server. An amendment can cross a
    // threshold (the $1M referral limit, say) so the rule set is worth re-reading, but deciding
    // which rules now bite is an underwriter's call, not this tool's.
    const rules = await query(
      'SELECT rule_code, description, outcome FROM underwriting_rules WHERE product_code = $1 ORDER BY rule_code',
      [targetProduct],
    );

    return text({
      changed: true,
      application_number,
      previous: { product_code: application.product_code, face_amount: Number(application.face_amount) },
      current: { product_code: targetProduct, face_amount: targetFace },
      status_unchanged: application.status,
      rules_to_re_review: rules,
      note: 'Hard limits were re-checked. Underwriting rules are reported for re-review, not evaluated.',
    });
  },
);

server.registerTool(
  'find_similar_documents',
  {
    title: 'Find similar documents',
    description:
      'Given one document, find the others closest to it in meaning. Use this after landing on a ' +
      'clause to find related provisions elsewhere in the corpus — the rider that modifies it, the ' +
      'procedure that acts on it. Different from search_policy_documents, which starts from a ' +
      'question; this starts from a document you already have.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      doc_id: z.string().describe('e.g. TRM20-CONTRACT-02'),
      limit: z.number().int().min(1).max(10).optional().describe('Default 3'),
    },
  },
  async ({ doc_id, limit = 3 }) => {
    const [source] = await query(
      'SELECT doc_id, title, doc_type, product_code FROM policy_documents WHERE doc_id = $1',
      [doc_id],
    );
    if (!source) {
      const available = await query('SELECT doc_id, title FROM policy_documents ORDER BY doc_id');
      return text({ error: `No document with doc_id ${doc_id}.`, available });
    }

    // Reuses the embeddings already stored at seed time — no model call needed, because the
    // source document's position was computed once and kept.
    const rows = await query(
      `SELECT d.doc_id, d.title, d.doc_type, d.product_code,
              1 - (d.embedding <=> s.embedding) AS similarity
         FROM policy_documents d
         CROSS JOIN (SELECT embedding FROM policy_documents WHERE doc_id = $1) s
        WHERE d.doc_id <> $1
        ORDER BY d.embedding <=> s.embedding
        LIMIT $2`,
      [doc_id, limit],
    );

    return text({
      source,
      similar: rows.map((row) => ({ ...row, similarity: Number(Number(row.similarity).toFixed(4)) })),
      note: 'Similarity is by wording and subject matter. A closely related document may state the opposite rule — read it, do not assume it agrees.',
    });
  },
);

server.registerTool(
  'get_requirement_catalog',
  {
    title: 'Get requirement catalogue',
    description:
      'Every requirement type seen across the book, with how often it has been ordered, how many are ' +
      'still open, and how long the closed ones took. Use this before ordering — it answers "how long ' +
      'will an APS hold this case up" — and to spot which vendors are slow. ' +
      'get_outstanding_requirements shows what is open right now; this shows historical behaviour.',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  async () => {
    const byCode = await query(
      `SELECT requirement_code,
              COUNT(*)::int AS times_ordered,
              COUNT(*) FILTER (WHERE status = 'outstanding')::int AS currently_outstanding,
              COUNT(*) FILTER (WHERE status = 'received')::int AS received,
              COUNT(*) FILTER (WHERE status = 'waived')::int AS waived,
              ROUND(AVG(EXTRACT(EPOCH FROM (received_at - ordered_at)) / 86400.0)
                    FILTER (WHERE received_at IS NOT NULL), 1) AS avg_days_to_receive,
              COUNT(*) FILTER (WHERE received_at IS NOT NULL)::int AS turnaround_sample_size
         FROM requirements
        GROUP BY requirement_code
        ORDER BY times_ordered DESC, requirement_code`,
    );

    const byVendor = await query(
      `SELECT vendor,
              COUNT(*)::int AS ordered,
              COUNT(*) FILTER (WHERE status = 'outstanding')::int AS still_open,
              ROUND(AVG(EXTRACT(EPOCH FROM (received_at - ordered_at)) / 86400.0)
                    FILTER (WHERE received_at IS NOT NULL), 1) AS avg_days_to_receive
         FROM requirements
        WHERE vendor IS NOT NULL
        GROUP BY vendor
        ORDER BY ordered DESC`,
    );

    return text({
      by_requirement: byCode,
      by_vendor: byVendor,
      caveat:
        'Turnaround figures come from a handful of closed requirements — check turnaround_sample_size ' +
        'before treating any average as typical. A sample of one is an anecdote, not a benchmark.',
    });
  },
);

await server.connect(new StdioServerTransport());
