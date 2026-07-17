import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArxivId, fetchTitle, fetchPdf, getNumPages, extractPages, splitSentences } from './arxiv.js';
import { translateAll } from './translate.js';
import { cleanSentences } from './cleanup.js';
import { savePaper, loadPaper, listPapers, deletePaper, paperIdFor } from './store.js';

const PORT = process.env.PORT || 5175;
const app = express();
app.use(express.json({ limit: '2mb' }));

const asyncRoute = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal error' });
  });

// Translate whatever sentences still lack a Korean translation, persisting
// after every chunk so a restart (or a retry after an error) resumes cleanly.
async function runTranslation(id) {
  const paper = await loadPaper(id);
  if (!paper) return;
  const missing = paper.sentences.filter((s) => !s.ko);
  const finish = async () => {
    const p = await loadPaper(id);
    if (!p) return;
    p.translatedCount = p.sentences.filter((s) => s.ko).length;
    p.status = p.translatedCount >= p.sentences.length ? 'ready' : 'translating';
    p.updatedAt = new Date().toISOString();
    await savePaper(p);
  };
  if (missing.length === 0) return finish();
  await translateAll(missing.map((s) => s.en), async (count, partial) => {
    const p = await loadPaper(id);
    if (!p) return;
    for (let i = 0; i < count; i++) if (partial[i]) p.sentences[missing[i].idx].ko = partial[i];
    p.translatedCount = p.sentences.filter((s) => s.ko).length;
    p.status = p.translatedCount >= p.sentences.length ? 'ready' : 'translating';
    p.updatedAt = new Date().toISOString();
    await savePaper(p);
  });
}

const failTranslation = (id) => async (err) => {
  console.error('Translation failed:', err);
  const p = await loadPaper(id);
  if (!p) return;
  p.status = 'error';
  p.error = err.message;
  await savePaper(p);
};

// Step 1 of import: resolve the link, report title + page count so the user can pick pages.
app.post('/api/inspect', asyncRoute(async (req, res) => {
  const arxivId = parseArxivId(String(req.body.url || ''));
  if (!arxivId) return res.status(400).json({ error: 'That does not look like an arXiv link or id.' });
  const [title, numPages] = await Promise.all([fetchTitle(arxivId), getNumPages(arxivId)]);
  res.json({ arxivId, title, numPages });
}));

// Step 2: extract the chosen pages, split into sentences, then translate in the background.
app.post('/api/papers', asyncRoute(async (req, res) => {
  const { arxivId, pageStart, pageEnd, title } = req.body;
  const from = Number(pageStart), to = Number(pageEnd);
  if (!arxivId || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return res.status(400).json({ error: 'Invalid page range.' });
  }
  const { pages, blocks: rawBlocks } = await extractPages(arxivId, from, to);
  const { sentences, masks, blocks } = splitSentences(rawBlocks);
  if (sentences.length === 0) {
    return res.status(422).json({ error: 'No usable sentences found in that page range.' });
  }

  const id = paperIdFor(arxivId, from, to);
  const existing = await loadPaper(id);
  if (existing && existing.status === 'ready') return res.json(existing); // resume, don't retranslate

  const paper = {
    id,
    arxivId,
    title: title || arxivId,
    pageStart: from,
    pageEnd: to,
    status: 'translating',
    error: null,
    translatedCount: 0,
    sentences: sentences.map((s) => ({ ...s, ko: null })),
    blocks,
    pages,
    masks,
    progress: { current: 0, attempts: {} },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await savePaper(paper);
  res.json(paper);

  // Background: repair PDF line-break artifacts with Codex, then translate.
  (async () => {
    const fixed = await cleanSentences(sentences.map((s) => s.en));
    const p = await loadPaper(id);
    if (!p) return;
    fixed.forEach((en, i) => {
      p.sentences[i].en = en;
    });
    p.updatedAt = new Date().toISOString();
    await savePaper(p);
    await runTranslation(id);
  })().catch(failTranslation(id));
}));

app.get('/api/papers', asyncRoute(async (_req, res) => res.json(await listPapers())));

app.get('/api/papers/:id', asyncRoute(async (req, res) => {
  const paper = await loadPaper(req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  res.json(paper);
}));

// The original PDF, for the preview panel.
app.get('/api/papers/:id/pdf', asyncRoute(async (req, res) => {
  const paper = await loadPaper(req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const data = await fetchPdf(paper.arxivId);
  res.type('application/pdf').send(Buffer.from(data));
}));

// Retry translation for a paper stuck in "error" (e.g. network hiccup).
app.post('/api/papers/:id/retranslate', asyncRoute(async (req, res) => {
  const paper = await loadPaper(req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  paper.status = 'translating';
  paper.error = null;
  await savePaper(paper);
  res.json(paper);
  runTranslation(paper.id).catch(failTranslation(paper.id));
}));

// Persist the user's writing progress (current position, attempts, hint counts).
app.put('/api/papers/:id/progress', asyncRoute(async (req, res) => {
  const paper = await loadPaper(req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const { current, attempts } = req.body || {};
  if (typeof current === 'number') {
    paper.progress.current = Math.max(0, Math.min(current, paper.sentences.length));
  }
  if (attempts && typeof attempts === 'object') paper.progress.attempts = attempts;
  paper.updatedAt = new Date().toISOString();
  await savePaper(paper);
  res.json({ ok: true });
}));

app.delete('/api/papers/:id', asyncRoute(async (req, res) => {
  await deletePaper(req.params.id);
  res.json({ ok: true });
}));

// Serve the built client in production.
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`✍️  writing-practice server on http://localhost:${PORT}`);
});
