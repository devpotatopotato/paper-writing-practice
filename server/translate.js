import { Codex } from '@openai/codex-sdk';

const MODEL = 'gpt-5.6-sol';
const REASONING_EFFORT = 'low';
const CHUNK_SIZE = 25;
const CHUNK_TIMEOUT_MS = 180_000;

const codex = new Codex();

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false,
};

function buildPrompt(sentences) {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return (
    `You are a professional academic translator. Translate each of the following ` +
    `${sentences.length} English sentences from a research paper into natural, formal ` +
    `Korean using academic written style (문어체, "-다" 체). Keep technical terms, ` +
    `math symbols, citations like [3], and proper nouns as-is when appropriate.\n\n` +
    `Return a JSON object with a "translations" array of exactly ${sentences.length} ` +
    `strings, where element i is the Korean translation of sentence i. Do not merge, ` +
    `split, or skip sentences. Do not run any commands or read any files.\n\n` +
    `Sentences:\n${numbered}`
  );
}

async function translateChunk(sentences) {
  const thread = codex.startThread({
    model: MODEL,
    modelReasoningEffort: REASONING_EFFORT,
    sandboxMode: 'read-only',
    skipGitRepoCheck: true,
  });
  const turn = await thread.run(buildPrompt(sentences), {
    outputSchema: OUTPUT_SCHEMA,
    signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
  });
  const parsed = JSON.parse(turn.finalResponse);
  if (!Array.isArray(parsed?.translations)) {
    throw new Error('Codex response has no translations array');
  }
  return parsed.translations.map((x) => String(x)).slice(0, sentences.length);
}

/**
 * Translate sentences to Korean in chunks via the Codex agent (ChatGPT login).
 * Calls onProgress(translatedCount) after each chunk so the caller can persist progress.
 */
export async function translateAll(sentences, onProgress) {
  const out = new Array(sentences.length).fill(null);
  for (let start = 0; start < sentences.length; start += CHUNK_SIZE) {
    const chunk = sentences.slice(start, start + CHUNK_SIZE);
    let translations;
    try {
      translations = await translateChunk(chunk);
    } catch {
      // One retry for the chunk, then fail the whole job with a clear message.
      translations = await translateChunk(chunk);
    }
    for (let i = 0; i < chunk.length; i++) {
      out[start + i] = translations[i] ?? '(translation failed)';
    }
    await onProgress?.(Math.min(start + CHUNK_SIZE, sentences.length), out);
  }
  return out;
}
