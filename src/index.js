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
    inputSchema: {
      query: z.string().describe('Natural-language question or keywords'),
      product_code: z.string().optional().describe('Restrict to one product, e.g. TRM-20'),
      limit: z.number().int().min(1).max(10).optional().describe('Max results, default 3'),
    },
  },
  async ({ query: searchText, product_code, limit = 3 }) => {
    const embedding = toVectorLiteral(embed(searchText));
    const rows = await query(
      `SELECT doc_id, title, doc_type, product_code,
              1 - (embedding <=> $1::vector) AS similarity,
              content
         FROM policy_documents
        WHERE ($2::text IS NULL OR product_code = $2)
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [embedding, product_code ?? null, limit],
    );

    if (rows.length === 0) return text('No matching documents.');

    return text(
      rows.map((row) => ({
        doc_id: row.doc_id,
        title: row.title,
        doc_type: row.doc_type,
        product_code: row.product_code,
        similarity: Number(row.similarity.toFixed(4)),
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

await server.connect(new StdioServerTransport());
