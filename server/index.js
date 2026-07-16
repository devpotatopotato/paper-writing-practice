import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArxivId, fetchTitle, getNumPages, extractPages, splitSentences } from './arxiv.js';
import { translateAll } from './translate.js';
import { savePaper, loadPaper, listPapers, deletePaper, paperIdFor } from './store.js';

const PORT = process.env.PORT || 5175;
const API_KEY = process.env.GEMINI_API_KEY;
const app = express();
app.use(express.json({ limit: '2mb' }));

const asyncRoute = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal error' });
  });

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
  if (!API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is missing in .env' });

  const pages = await extractPages(arxivId, from, to);
  const sentences = splitSentences(pages);
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
    progress: { current: 0, attempts: {} },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await savePaper(paper);
  res.json(paper);

  // Background translation; progress is persisted after every chunk so a restart resumes cleanly.
  translateAll(API_KEY, sentences.map((s) => s.en), async (count, partial) => {
    const p = await loadPaper(id);
    if (!p) return;
    for (let i = 0; i < count; i++) if (partial[i]) p.sentences[i].ko = partial[i];
    p.translatedCount = count;
    p.status = count >= sentences.length ? 'ready' : 'translating';
    p.updatedAt = new Date().toISOString();
    await savePaper(p);
  }).catch(async (err) => {
    console.error('Translation failed:', err);
    const p = await loadPaper(id);
    if (!p) return;
    p.status = 'error';
    p.error = err.message;
    await savePaper(p);
  });
}));

app.get('/api/papers', asyncRoute(async (_req, res) => res.json(await listPapers())));

app.get('/api/papers/:id', asyncRoute(async (req, res) => {
  const paper = await loadPaper(req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  res.json(paper);
}));

// Retry translation for a paper stuck in "error" (e.g. network hiccup).
app.post('/api/papers/:id/retranslate', asyncRoute(async (req, res) => {
  const paper = await loadPaper(req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  paper.status = 'translating';
  paper.error = null;
  await savePaper(paper);
  res.json(paper);
  translateAll(API_KEY, paper.sentences.map((s) => s.en), async (count, partial) => {
    const p = await loadPaper(paper.id);
    if (!p) return;
    for (let i = 0; i < count; i++) if (partial[i]) p.sentences[i].ko = partial[i];
    p.translatedCount = count;
    p.status = count >= p.sentences.length ? 'ready' : 'translating';
    p.updatedAt = new Date().toISOString();
    await savePaper(p);
  }).catch(async (err) => {
    const p = await loadPaper(paper.id);
    if (!p) return;
    p.status = 'error';
    p.error = err.message;
    await savePaper(p);
  });
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
  if (!API_KEY) console.warn('⚠️  GEMINI_API_KEY not found in .env — translation will fail.');
});
