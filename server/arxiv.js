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

const round = (n) => Math.round(n * 10) / 10;

/** Collect visual lines from a pdf.js page: {str, page, x, y, w, h} in PDF coords (y = baseline). */
function collectLines(content, pageNum) {
  const lines = [];
  let line = null;
  const flush = () => {
    if (line && line.str.replace(/\s+/g, ' ').trim()) {
      lines.push({
        str: line.str.replace(/\s+/g, ' ').trim(),
        page: pageNum,
        x: round(line.x0),
        y: round(line.y),
        w: round(Math.max(1, line.x1 - line.x0)),
        h: round(line.h),
      });
    }
    line = null;
  };
  for (const item of content.items) {
    if (item.str.trim()) {
      const x0 = item.transform[4];
      const x1 = x0 + (item.width || 0);
      if (!line) line = { str: '', x0, x1, y: item.transform[5], h: 0 };
      else {
        line.x0 = Math.min(line.x0, x0);
        line.x1 = Math.max(line.x1, x1);
      }
      line.h = Math.max(line.h, item.height || 0);
    }
    if (line) line.str += item.str;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

/** Dominant body font size: mode of line heights weighted by text length. */
function bodyFontSize(lines) {
  const weight = new Map();
  for (const l of lines) {
    const key = Math.round(l.h * 2) / 2;
    weight.set(key, (weight.get(key) || 0) + l.str.length);
  }
  let best = 10, bestW = 0;
  for (const [h, w] of weight) if (w > bestW) { best = h; bestW = w; }
  return best;
}

/**
 * Vocabulary of the whole document, used to decide whether a hyphen at a line
 * break is a syllable break ("prob-lems" → "problems") or a real compound
 * hyphen that must be kept ("research-level").
 */
function buildVocab(lines) {
  const plain = new Set();
  const hyphen = new Set();
  for (const l of lines) {
    for (const w of l.str.match(/[A-Za-z]+/g) || []) plain.add(w.toLowerCase());
    // hyphenated tokens seen intact inside a line (not at its end)
    for (const w of l.str.match(/[A-Za-z0-9]+-[A-Za-z0-9]+/g) || []) {
      if (!l.str.endsWith(w.slice(0, w.indexOf('-') + 1))) hyphen.add(w.toLowerCase());
    }
  }
  return { plain, hyphen };
}

/** Should the line-break hyphen between `head-` and `tail…` be kept? */
function keepHyphen(head, tail, vocab) {
  if (!head || !tail) return false;
  if (/^[A-Z0-9]/.test(tail)) return true; // identifiers: RESEARCHMATH-14K, Qwen3-30B
  const h = `${head}-${tail}`.toLowerCase();
  const p = `${head}${tail}`.toLowerCase();
  if (vocab.hyphen.has(h)) return true; // compound seen intact elsewhere
  if (vocab.plain.has(p)) return false; // merged word seen intact elsewhere
  // both halves are real standalone words → likely a compound
  return (
    head.length >= 3 &&
    tail.length >= 3 &&
    vocab.plain.has(head.toLowerCase()) &&
    vocab.plain.has(tail.toLowerCase())
  );
}

/**
 * Join a block's lines into one string (de-hyphenating words broken across
 * lines) and record which [start, end) range of the string each line covers.
 */
function joinLines(lines, vocab) {
  let text = '';
  const spans = [];
  for (const line of lines) {
    if (text.endsWith('-')) {
      const head = text.match(/([A-Za-z]+)-$/)?.[1];
      const tail = line.str.match(/^([A-Za-z0-9]+)/)?.[1];
      if (!keepHyphen(head, tail, vocab)) text = text.slice(0, -1);
    } else if (text) text += ' ';
    const start = text.length;
    text += line.str;
    spans.push({ start, end: text.length, line });
  }
  return { text, spans };
}

const HEADING_RE = /^([12]?\d(\.\d+)*\.?\s+[A-Z]|(Abstract|References|Acknowledg\w*|Appendix|Conclusion)s?\b)/;
const CAPTION_RE = /^(Figure|Table|Algorithm|Listing)\s*\d+\s*[:.]/i;

/** Group lines into visual blocks and classify them. */
function blocksForPage(lines, pageNum, bodyH, vocab) {
  // Drop watermarks and bare page numbers.
  const kept = lines.filter(
    (l) => !/^arXiv:\d{4}\.\d{4,5}/.test(l.str) && !(l.y < 60 && /^\d{1,4}$/.test(l.str))
  );

  // Segment into blocks on column jumps, vertical gaps, font-size changes, and paragraph indents.
  const groups = [];
  let cur = null;
  for (const l of kept) {
    const prev = cur?.[cur.length - 1];
    const breakHere =
      !prev ||
      l.y > prev.y + 2 || // moved up: new column
      prev.y - l.y > 1.7 * Math.max(prev.h, l.h, 8) || // large vertical gap
      Math.abs(l.h - prev.h) > 1.0 || // font size change
      l.x > prev.x + 5; // indented first line of a new paragraph
    if (breakHere) {
      cur = [l];
      groups.push(cur);
    } else {
      cur.push(l);
    }
  }

  // Classify.
  const blocks = [];
  let titleSeen = false;
  let bodySeen = false;
  for (const g of groups) {
    const { text, spans } = joinLines(g, vocab);
    const h = Math.max(...g.map((l) => l.h));
    const y = g[0].y;
    let type = 'paragraph';
    if (pageNum === 1 && !titleSeen && !bodySeen && h >= bodyH + 2 && text.length > 8) {
      type = 'title';
      titleSeen = true;
    } else if (HEADING_RE.test(text) && text.length < 120 && (h > bodyH + 0.5 || text.split(/\s+/).length <= 8)) {
      type = 'heading';
    } else if (pageNum === 1 && titleSeen && !bodySeen && h > bodyH + 0.5) {
      type = 'authors';
    } else if (CAPTION_RE.test(text)) {
      type = 'caption';
    } else if (h <= bodyH - 1.4 && y < 110) {
      type = 'footnote';
    }
    if (type === 'paragraph' || type === 'caption') bodySeen = true;
    blocks.push({ type, page: pageNum, text, spans });
  }
  return blocks;
}

/**
 * Extract structured blocks for pages [from..to] (1-indexed, inclusive).
 * Returns:
 *   pages  — [{page, width, height}] PDF page sizes (scale 1) for the client viewer
 *   blocks — [{type, page, text, spans}] in reading order; paragraphs that
 *            continue across columns/pages are merged back together, and
 *            spans map char ranges of text back to physical lines.
 */
export async function extractPages(arxivId, from, to) {
  const doc = await loadDocument(await fetchPdf(arxivId));
  const first = Math.max(1, from);
  const last = Math.min(doc.numPages, to);
  const pages = [];
  const pageLines = [];
  for (let p = first; p <= last; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ page: p, width: round(viewport.width), height: round(viewport.height) });
    pageLines.push(collectLines(await page.getTextContent(), p));
    page.cleanup();
  }
  await doc.destroy();

  // De-hyphenation decisions consult the whole document's vocabulary.
  const vocab = buildVocab(pageLines.flat());
  const all = [];
  for (let i = 0; i < pageLines.length; i++) {
    const lines = pageLines[i];
    if (lines.length) all.push(...blocksForPage(lines, first + i, bodyFontSize(lines), vocab));
  }

  // Merge paragraphs that were split mid-sentence by a column or page break.
  const merged = [];
  for (const b of all) {
    if (b.type === 'paragraph') {
      const prev = [...merged].reverse().find((x) => x.type === 'paragraph');
      if (prev && !/[.!?:]$/.test(prev.text) && /^[a-z0-9(]/.test(b.text)) {
        let joined = prev.text + ' ';
        if (prev.text.endsWith('-')) {
          const head = prev.text.match(/([A-Za-z]+)-$/)?.[1];
          const tail = b.text.match(/^([A-Za-z0-9]+)/)?.[1];
          joined = keepHyphen(head, tail, vocab) ? prev.text : prev.text.slice(0, -1);
        }
        const offset = joined.length;
        prev.text = joined + b.text;
        for (const s of b.spans) prev.spans.push({ start: s.start + offset, end: s.end + offset, line: s.line });
        continue;
      }
    }
    merged.push({ ...b, spans: [...b.spans] });
  }
  return { pages, blocks: merged };
}

// Abbreviations whose trailing period must not end a sentence.
const ABBREVS = [
  'et al.', 'e.g.', 'i.e.', 'w.r.t.', 'etc.', 'vs.', 'cf.', 'resp.', 'approx.',
  'Fig.', 'Figs.', 'fig.', 'figs.', 'Eq.', 'Eqs.', 'eq.', 'eqs.', 'Sec.', 'Secs.',
  'Tab.', 'Tabs.', 'Ref.', 'Refs.', 'App.', 'Appx.', 'Ch.', 'Alg.', 'Thm.', 'Def.',
  'Prop.', 'Lem.', 'Cor.', 'No.', 'pp.', 'Dr.', 'Mr.', 'Ms.', 'Mrs.', 'Prof.', 'St.',
];
const DOT = '\u0001'; // placeholder for protected dots while splitting

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

/** Rects (PDF coords, y = line baseline) covering chars [s, e) of a block via its line spans. */
function rectsForRange(spans, s, e) {
  const rects = [];
  for (const { start, end, line } of spans) {
    const os = Math.max(s, start);
    const oe = Math.min(e, end);
    if (oe <= os || end === start) continue;
    const f0 = (os - start) / (end - start);
    const f1 = (oe - start) / (end - start);
    rects.push({
      page: line.page,
      x: round(line.x + line.w * f0),
      y: line.y,
      w: round(line.w * (f1 - f0)),
      h: line.h,
    });
  }
  return rects;
}

/**
 * Turn extracted blocks into practice sentences plus renderable structure.
 * Returns:
 *   sentences — [{idx, page, en, rects}] prose sentences the user practices;
 *               rects locate the sentence on the original PDF pages
 *   masks     — [{revealAt, rects}] non-practice content (headings, equations,
 *               footnotes…) that stays blurred until the user reaches practice
 *               sentence `revealAt`; title and authors are never masked
 *   blocks    — [{type, page, segments: [{en, idx|null}]}] fallback HTML structure
 */
export function splitSentences(blocks) {
  const sentences = [];
  const outBlocks = [];
  const masks = [];
  const pending = []; // masks waiting for the next practice sentence to set revealAt
  const addMask = (rects) => {
    if (!rects.length) return;
    const mask = { revealAt: sentences.length, rects };
    masks.push(mask);
    pending.push(mask);
  };
  const addSentence = (page, en, rects) => {
    sentences.push({ idx: sentences.length, page, en, rects });
    for (const m of pending) m.revealAt = sentences.length - 1;
    pending.length = 0;
    return sentences.length - 1;
  };
  let inReferences = false;
  for (const b of blocks) {
    // The reference list is not writing material: keep it fully visible,
    // never practiced, never blurred. A later non-References heading
    // (e.g. an appendix) switches back to normal treatment.
    if (b.type === 'heading') inReferences = /^References?\b/i.test(b.text);
    if (inReferences) {
      outBlocks.push({ type: b.type, page: b.page, segments: [{ en: b.text, idx: null }] });
      continue;
    }
    let segments;
    if (b.type === 'paragraph') {
      const protectedText = protectAbbrevs(b.text);
      // Split into [start, end) sentence ranges so each part keeps its position.
      const ranges = [];
      let cursor = 0;
      for (const m of protectedText.matchAll(/(?<=[.!?])\s+(?=[A-Z“"(‘'])/g)) {
        ranges.push([cursor, m.index]);
        cursor = m.index + m[0].length;
      }
      ranges.push([cursor, protectedText.length]);
      segments = [];
      for (let [s, e] of ranges) {
        while (s < e && protectedText[s] === ' ') s++;
        while (e > s && protectedText[e - 1] === ' ') e--;
        const en = protectedText.slice(s, e).replaceAll(DOT, '.');
        if (!en) continue;
        const rects = rectsForRange(b.spans, s, e);
        if (looksLikeProse(en) && en.length <= 600) {
          const idx = addSentence(b.page, en, rects);
          segments.push({ en, idx });
        } else {
          addMask(rects);
          segments.push({ en, idx: null });
        }
      }
    } else {
      // Headings, captions, footnotes: never practiced, blurred until reached.
      if (b.type !== 'title' && b.type !== 'authors') {
        addMask(rectsForRange(b.spans, 0, b.text.length));
      }
      segments = [{ en: b.text, idx: null }];
    }
    if (segments.length) outBlocks.push({ type: b.type, page: b.page, segments });
  }
  for (const m of pending) m.revealAt = sentences.length;
  return { sentences, masks, blocks: outBlocks };
}
