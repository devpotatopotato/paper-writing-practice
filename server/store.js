import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export function paperIdFor(arxivId, from, to) {
  return `${arxivId.replace(/[/.]/g, '_')}__p${from}-${to}`;
}

function fileFor(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid paper id');
  return path.join(DATA_DIR, `${id}.json`);
}

export async function savePaper(paper) {
  await ensureDir();
  const tmp = fileFor(paper.id) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(paper, null, 2));
  await fs.rename(tmp, fileFor(paper.id));
}

export async function loadPaper(id) {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

export async function deletePaper(id) {
  try {
    await fs.unlink(fileFor(id));
  } catch {
    /* already gone */
  }
}

export async function listPapers() {
  await ensureDir();
  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  const papers = [];
  for (const f of files) {
    const p = await loadPaper(f.replace(/\.json$/, ''));
    if (!p) continue;
    papers.push({
      id: p.id,
      arxivId: p.arxivId,
      title: p.title,
      pageStart: p.pageStart,
      pageEnd: p.pageEnd,
      status: p.status,
      error: p.error || null,
      totalSentences: p.sentences.length,
      translatedCount: p.translatedCount ?? p.sentences.filter((s) => s.ko).length,
      current: p.progress?.current ?? 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }
  papers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return papers;
}
