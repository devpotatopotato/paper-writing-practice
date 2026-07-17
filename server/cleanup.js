import { Codex } from '@openai/codex-sdk';

const MODEL = 'gpt-5.6-sol';
const REASONING_EFFORT = 'low';
const CHUNK_SIZE = 40;
const CHUNK_TIMEOUT_MS = 180_000;

const codex = new Codex();

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { sentences: { type: 'array', items: { type: 'string' } } },
  required: ['sentences'],
  additionalProperties: false,
};

function buildPrompt(sentences) {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return (
    `The following ${sentences.length} sentences were extracted from a research-paper ` +
    `PDF. Words broken across line ends may have been rejoined incorrectly: a missing ` +
    `hyphen ("researchlevel" should be "research-level"), a hyphen that should not be ` +
    `there ("prob-lems" should be "problems"), or a missing space. Fix ONLY such ` +
    `word-joining artifacts. Do not reword, reorder, add, or remove anything else — ` +
    `keep every sentence otherwise byte-identical. Do not run any commands or read any files.\n\n` +
    `Return a JSON object with a "sentences" array of exactly ${sentences.length} ` +
    `strings: sentence i, corrected (or unchanged if already fine).\n\n` +
    `Sentences:\n${numbered}`
  );
}

// A fix may only move hyphens/spaces around; anything else is rejected.
const skeleton = (s) => s.replace(/[\s-]+/g, '').toLowerCase();

async function cleanChunk(sentences) {
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
  if (!Array.isArray(parsed?.sentences) || parsed.sentences.length !== sentences.length) {
    throw new Error('Codex cleanup returned wrong sentence count');
  }
  return sentences.map((orig, i) => {
    const fixed = String(parsed.sentences[i]).replace(/\s+/g, ' ').trim();
    return skeleton(fixed) === skeleton(orig) ? fixed : orig;
  });
}

/**
 * Best-effort repair of PDF line-break artifacts in extracted sentences via
 * Codex. Same count and order; a failed chunk falls back to the originals.
 */
export async function cleanSentences(texts) {
  const out = [];
  for (let start = 0; start < texts.length; start += CHUNK_SIZE) {
    const chunk = texts.slice(start, start + CHUNK_SIZE);
    try {
      out.push(...(await cleanChunk(chunk)));
    } catch (err) {
      try {
        out.push(...(await cleanChunk(chunk)));
      } catch {
        console.error('Sentence cleanup failed for a chunk, keeping raw text:', err.message);
        out.push(...chunk);
      }
    }
  }
  return out;
}
