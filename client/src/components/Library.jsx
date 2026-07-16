import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Library({ onOpen, onNew }) {
  const [papers, setPapers] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => api.listPapers().then(setPapers).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  const remove = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this paper and all of your progress on it?')) return;
    await api.deletePaper(id);
    refresh();
  };

  return (
    <div className="library">
      <header className="library-header">
        <div>
          <h1>
            Paper Writing <span className="accent">Practice</span>
          </h1>
          <p className="subtitle">한국어 번역을 보고 영어 논문 문장을 다시 써보는 연습장</p>
        </div>
        <button className="btn btn-primary" onClick={onNew}>
          + Import arXiv paper
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {papers === null ? (
        <div className="empty-state">Loading…</div>
      ) : papers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📄</div>
          <p>No papers yet. Import an arXiv paper to start practicing.</p>
        </div>
      ) : (
        <div className="paper-grid">
          {papers.map((p) => {
            const pct = p.totalSentences ? Math.round((100 * p.current) / p.totalSentences) : 0;
            return (
              <div key={p.id} className="paper-card" onClick={() => onOpen(p.id)}>
                <div className="paper-card-top">
                  <span className="paper-badge">
                    {p.arxivId} · p.{p.pageStart}–{p.pageEnd}
                  </span>
                  <button className="btn-icon" title="Delete" onClick={(e) => remove(e, p.id)}>
                    ✕
                  </button>
                </div>
                <h3>{p.title}</h3>
                {p.status === 'translating' ? (
                  <div className="paper-status translating">
                    Translating… {p.translatedCount}/{p.totalSentences}
                  </div>
                ) : p.status === 'error' ? (
                  <div className="paper-status error">Translation failed — open to retry</div>
                ) : (
                  <>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="paper-meta">
                      {p.current}/{p.totalSentences} sentences · {pct}%
                      {pct === 100 && ' 🎉'}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
