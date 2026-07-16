const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.0-flash'];
const CHUNK_SIZE = 25;

function buildPrompt(sentences) {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return (
    `You are a professional academic translator. Translate each of the following ` +
    `${sentences.length} English sentences from a research paper into natural, formal ` +
    `Korean using academic written style (문어체, "-다" 체). Keep technical terms, ` +
    `math symbols, citations like [3], and proper nouns as-is when appropriate.\n\n` +
    `Return ONLY a JSON array of exactly ${sentences.length} strings, where element i ` +
    `is the Korean translation of sentence i. Do not merge, split, or skip sentences.\n\n` +
    `Sentences:\n${numbered}`
  );
}

async function callGemini(apiKey, prompt) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
          }),
        }
      );
      if (res.ok) {
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        return text;
      }
      const body = await res.text();
      lastErr = new Error(`Gemini ${model} HTTP ${res.status}: ${body.slice(0, 300)}`);
      if (res.status === 404 || res.status === 400) break; // try next model
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('Gemini call failed');
}

function parseArray(text, expected) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    // Salvage a JSON array embedded in surrounding text.
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('Gemini returned non-JSON response');
    arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr)) throw new Error('Gemini response is not an array');
  return arr.map((x) => String(x)).slice(0, expected);
}

/**
 * Translate sentences to Korean in chunks.
 * Calls onProgress(translatedCount) after each chunk so the caller can persist progress.
 */
export async function translateAll(apiKey, sentences, onProgress) {
  const out = new Array(sentences.length).fill(null);
  for (let start = 0; start < sentences.length; start += CHUNK_SIZE) {
    const chunk = sentences.slice(start, start + CHUNK_SIZE);
    let translations;
    try {
      translations = parseArray(await callGemini(apiKey, buildPrompt(chunk)), chunk.length);
    } catch (err) {
      // One retry for the chunk, then fail the whole job with a clear message.
      translations = parseArray(await callGemini(apiKey, buildPrompt(chunk)), chunk.length);
    }
    for (let i = 0; i < chunk.length; i++) {
      out[start + i] = translations[i] ?? '(번역 실패)';
    }
    await onProgress?.(Math.min(start + CHUNK_SIZE, sentences.length), out);
  }
  return out;
}
