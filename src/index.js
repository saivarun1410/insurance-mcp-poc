#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { query } from './db.js';
import { embed, toVectorLiteral } from './embed.js';

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
    const embedding = toVectorLiteral(embed(searchText));
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
        ORDER BY score DESC
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

await server.connect(new StdioServerTransport());
