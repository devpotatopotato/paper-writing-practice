import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// In-memory cache of downloaded PDFs so "inspect" then "import" doesn't download twice.
const pdfCache = new Map(); // arxivId -> Uint8Array

export function parseArxivId(input) {
  const s = input.trim();
  // Accept bare ids ("2404.12345", "1706.03762v5", "cs/0301012") and any arxiv.org URL form.
  const urlMatch = s.match(
    /arxiv\.org\/(?:abs|pdf|html)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?)/i
  );
  if (urlMatch) return urlMatch[1].replace(/\.pdf$/i, '');
  const bareMatch = s.match(/^((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?)$/i);
  if (bareMatch) return bareMatch[1];
  return null;
}

export async function fetchTitle(arxivId) {
  try {
    const res = await fetch(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`
    );
    const xml = await res.text();
    const entry = xml.split('<entry>')[1] || '';
    const m = entry.match(/<title>([\s\S]*?)<\/title>/);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  } catch {
    /* title is cosmetic; fall through */
  }
  return arxivId;
}

export async function fetchPdf(arxivId) {
  if (pdfCache.has(arxivId)) return pdfCache.get(arxivId);
  const url = `https://arxiv.org/pdf/${arxivId}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to download PDF (HTTP ${res.status}) from ${url}`);
  const data = new Uint8Array(await res.arrayBuffer());
  pdfCache.set(arxivId, data);
  // Keep the cache small.
  if (pdfCache.size > 5) pdfCache.delete(pdfCache.keys().next().value);
  return data;
}

async function loadDocument(data) {
  return pdfjs.getDocument({
    // pdfjs mutates/transfers the buffer, so hand it a copy.
    data: data.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
}

export async function getNumPages(arxivId) {
  const doc = await loadDocument(await fetchPdf(arxivId));
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/** Extract plain text for pages [from..to] (1-indexed, inclusive). Returns [{page, text}]. */
export async function extractPages(arxivId, from, to) {
  const doc = await loadDocument(await fetchPdf(arxivId));
  const pages = [];
  const first = Math.max(1, from);
  const last = Math.min(doc.numPages, to);
  for (let p = first; p <= last; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = [];
    let line = '';
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    // Re-join lines: de-hyphenate words broken across lines, otherwise join with a space.
    let text = '';
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (text.endsWith('-')) text = text.slice(0, -1) + t;
      else text += (text ? ' ' : '') + t;
    }
    pages.push({ page: p, text: text.replace(/\s+/g, ' ').trim() });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

// Abbreviations whose trailing period must not end a sentence.
const ABBREVS = [
  'et al.', 'e.g.', 'i.e.', 'w.r.t.', 'etc.', 'vs.', 'cf.', 'resp.', 'approx.',
  'Fig.', 'Figs.', 'fig.', 'figs.', 'Eq.', 'Eqs.', 'eq.', 'eqs.', 'Sec.', 'Secs.',
  'Tab.', 'Tabs.', 'Ref.', 'Refs.', 'App.', 'Appx.', 'Ch.', 'Alg.', 'Thm.', 'Def.',
  'Prop.', 'Lem.', 'Cor.', 'No.', 'pp.', 'Dr.', 'Mr.', 'Ms.', 'Mrs.', 'Prof.', 'St.',
];
const DOT = '';

function protectAbbrevs(text) {
  let out = text;
  for (const a of ABBREVS) {
    out = out.split(a).join(a.replaceAll('.', DOT));
  }
  return out;
}

function looksLikeProse(s) {
  const words = s.split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w));
  if (words.length < 5) return false;
  const letters = (s.match(/[a-zA-Z\s]/g) || []).length;
  if (letters / s.length < 0.6) return false; // math/citation soup
  return true;
}

/** Split page texts into practice sentences: [{idx, page, en}]. */
export function splitSentences(pages) {
  const sentences = [];
  for (const { page, text } of pages) {
    const protectedText = protectAbbrevs(text);
    const parts = protectedText.split(/(?<=[.!?])\s+(?=[A-Z“"(‘'])/);
    for (const raw of parts) {
      const s = raw.replaceAll(DOT, '.').replace(/\s+/g, ' ').trim();
      if (looksLikeProse(s) && s.length <= 600) {
        sentences.push({ idx: sentences.length, page, en: s });
      }
    }
  }
  return sentences;
}
