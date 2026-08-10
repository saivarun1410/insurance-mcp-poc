// Deterministic local embedding so the POC runs offline with no API key.
//
// This is a hashed bag-of-words/bigrams projection, not a semantic model: it matches
// on vocabulary overlap, not meaning. It is here so `npm run setup` works on a laptop
// with nothing configured. To make retrieval actually semantic, replace embed() with a
// call to a real embedding model — that is the only function that needs to change.
// See README "Swapping in a real embedding model".

export const EMBEDDING_DIM = 256;

function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function bucket(token, seed) {
  let hash = seed;
  for (let i = 0; i < token.length; i++) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % EMBEDDING_DIM;
}

export function embed(text) {
  const vector = new Float64Array(EMBEDDING_DIM);
  const tokens = tokenize(text);

  for (const token of tokens) {
    vector[bucket(token, 7)] += 1;
  }
  // Bigrams at half weight give phrase matches a modest edge over bag-of-words alone.
  for (let i = 0; i < tokens.length - 1; i++) {
    vector[bucket(`${tokens[i]}_${tokens[i + 1]}`, 13)] += 0.5;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;

  return Array.from(vector, (value) => value / norm);
}

// pgvector's text input format.
export function toVectorLiteral(values) {
  return `[${values.join(',')}]`;
}
