// Retrieval benchmark. Ten questions with a known-correct document, scored three ways:
// vector similarity alone, Postgres full-text alone, and the RRF hybrid the server actually uses.
//
// The point is to be able to answer "is the vector half earning its keep" with a number rather
// than an opinion — particularly before and after changing the embedding in src/embed.js.
//
//   npm run benchmark
import { pool, query } from '../src/db.js';
import { embed, toVectorLiteral } from '../src/embed.js';

// Where more than one document is a fair answer, both are accepted.
const CASES = [
  ['what happens if the insured dies by suicide within two years', ['TRM20-CONTRACT-02']],
  ['how do policy loans affect the death benefit',                 ['WL100-CONTRACT-01', 'TRM20-CONTRACT-01']],
  ['when is an application closed as incomplete',                  ['PROC-REQ-01']],
  ['contestability investigation after a death claim',             ['PROC-CLAIM-01']],
  ['when is a paramedical examination required',                   ['GUIDE-UW-01']],
  ['what is the grace period before the policy lapses',            ['UL200-CONTRACT-01', 'TRM20-CONTRACT-03']],
  ['body mass index table rating',                                 ['GUIDE-UW-02']],
  ['definition of total disability for waiver of premium',         ['RIDER-WP-01']],
  ['accelerated benefit for chronic illness',                      ['RIDER-ADB-01']],
  ['how many times annual income can someone be covered for',      ['GUIDE-UW-03']],
];

// Paraphrases of one question, none of which share the word "suicide" with the target document.
// Full-text search cannot answer these by construction; a real embedding model should.
const PARAPHRASES = [
  ['what happens if the insured dies by suicide', 'TRM20-CONTRACT-02'],
  ['if the policyholder takes their own life', 'TRM20-CONTRACT-02'],
  ['can the company refuse to pay for a self-inflicted death', 'TRM20-CONTRACT-02'],
];

const VECTOR_ONLY = `SELECT doc_id FROM policy_documents ORDER BY embedding <=> $1::vector LIMIT 1`;

const TEXT_ONLY = `
  SELECT doc_id FROM policy_documents
   WHERE content_tsv @@ replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery
   ORDER BY ts_rank_cd(content_tsv, replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery) DESC
   LIMIT 1`;

const HYBRID = `
  WITH q AS (SELECT replace(websearch_to_tsquery('english', $2)::text, '&', '|')::tsquery AS tsq),
       v AS (SELECT doc_id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS r FROM policy_documents),
       t AS (SELECT doc_id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(content_tsv, (SELECT tsq FROM q)) DESC) AS r
               FROM policy_documents WHERE content_tsv @@ (SELECT tsq FROM q))
  SELECT p.doc_id
    FROM policy_documents p
    LEFT JOIN v ON v.doc_id = p.doc_id
    LEFT JOIN t ON t.doc_id = p.doc_id
   ORDER BY COALESCE(1.0 / (60 + v.r), 0) + COALESCE(1.0 / (60 + t.r), 0) DESC,
            COALESCE(v.r, 2147483647), p.doc_id
   LIMIT 1`;

const top = async (sql, params) => (await query(sql, params))[0]?.doc_id ?? '—';

async function main() {
  let vector = 0;
  let text = 0;
  let hybrid = 0;

  console.log('\nTOP-1 RETRIEVAL\n');
  console.log(`${'question'.padEnd(50)} ${'vector'.padEnd(21)} ${'text'.padEnd(21)} hybrid`);

  for (const [question, accepted] of CASES) {
    // `await` works whether embed() is synchronous or returns a promise, so this file is
    // unchanged when the embedding backend is swapped.
    const vec = toVectorLiteral(await embed(question));
    const v = await top(VECTOR_ONLY, [vec]);
    const t = await top(TEXT_ONLY, [question]);
    const h = await top(HYBRID, [vec, question]);

    const mark = (docId) => (accepted.includes(docId) ? '✓' : '✗');
    vector += accepted.includes(v);
    text += accepted.includes(t);
    hybrid += accepted.includes(h);

    console.log(
      `${question.slice(0, 48).padEnd(50)} ${`${mark(v)} ${v}`.padEnd(21)} ${`${mark(t)} ${t}`.padEnd(21)} ${mark(h)} ${h}`,
    );
  }

  const n = CASES.length;
  console.log(`\nSCORE   vector ${vector}/${n}   text ${text}/${n}   hybrid ${hybrid}/${n}`);

  console.log('\nPARAPHRASE TEST — same question, different words\n');
  let paraphraseHits = 0;
  for (const [question, expected] of PARAPHRASES) {
    const vec = toVectorLiteral(await embed(question));
    const v = await top(VECTOR_ONLY, [vec]);
    const hit = v === expected;
    paraphraseHits += hit;
    console.log(`  ${hit ? '✓' : '✗'} ${`"${question}"`.padEnd(58)} vector -> ${v}`);
  }
  console.log(`\nSCORE   vector ${paraphraseHits}/${PARAPHRASES.length} on paraphrases`);
  console.log(
    '\nOnly the first paraphrase shares the word "suicide" with the target, so a lexical\n' +
      'embedding can score at most 1/3 here. This is the number a real model should move.\n',
  );

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
