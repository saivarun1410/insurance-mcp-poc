// Sentence embeddings from a real model, run locally in-process via transformers.js (ONNX).
// No API key, no separate service, no Python. The weights (~23MB quantized) download once on
// first use and are cached under ~/.cache/huggingface.
//
// Why a model rather than the hashed bag-of-words this file used to contain: that version
// scored 0.0000 similarity between "dies by suicide" and "takes their own life", because it
// matched shared vocabulary and those phrases share none. See scripts/benchmark.mjs.
//
// EMBEDDING_DIM must equal the vector(n) column width in db/init.sql. Changing the model
// almost certainly changes this number, and requires a rebuild and re-seed.
import { pipeline } from '@huggingface/transformers';

export const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2 output width

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Loaded once per process, lazily — so starting the MCP server stays instant and the cost is
// paid on the first search rather than at spawn. Storing the promise (not the resolved value)
// means concurrent first calls share one load instead of racing into two.
let extractorPromise;

function getExtractor() {
  extractorPromise ??= pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  return extractorPromise;
}

export async function embed(text) {
  const extractor = await getExtractor();
  // mean pooling over token vectors, then L2 normalise, which is what this model expects
  // and what makes cosine distance meaningful.
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// pgvector's text input format.
export function toVectorLiteral(values) {
  return `[${values.join(',')}]`;
}
