import { useState } from 'react';
import { api } from '../api.js';

export default function ImportWizard({ onCancel, onImported }) {
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState(null); // { arxivId, title, numPages }
  const [pageStart, setPageStart] = useState(1);
  const [pageEnd, setPageEnd] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const inspect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.inspect(url);
      setInfo(data);
      setPageStart(1);
      setPageEnd(Math.min(2, data.numPages));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const paper = await api.importPaper(info.arxivId, info.title, pageStart, pageEnd);
      onImported(paper.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="wizard">
      <div className="wizard-card">
        <button className="btn-link" onClick={onCancel}>
          ← Back to library
        </button>
        <h2>Import a paper</h2>

        {!info ? (
          <form onSubmit={inspect}>
            <label className="field-label">arXiv link or ID</label>
            <input
              className="text-input"
              placeholder="https://arxiv.org/abs/1706.03762"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
            <p className="hint-text">
              The PDF will be downloaded, split into sentences, and translated to Korean with Gemini.
            </p>
            <button className="btn btn-primary" disabled={busy || !url.trim()}>
              {busy ? 'Fetching paper…' : 'Fetch paper'}
            </button>
          </form>
        ) : (
          <div className="fade-in">
            <div className="paper-preview-info">
              <div className="paper-badge">{info.arxivId}</div>
              <h3>{info.title}</h3>
              <p className="hint-text">{info.numPages} pages in total</p>
            </div>

            <label className="field-label">Which pages do you want to practice?</label>
            <div className="page-range">
              <input
                type="number"
                className="text-input num"
                min={1}
                max={info.numPages}
                value={pageStart}
                onChange={(e) => setPageStart(Number(e.target.value))}
              />
              <span className="range-dash">to</span>
              <input
                type="number"
                className="text-input num"
                min={1}
                max={info.numPages}
                value={pageEnd}
                onChange={(e) => setPageEnd(Number(e.target.value))}
              />
              <span className="hint-text">of {info.numPages}</span>
            </div>
            <p className="hint-text">
              Tip: start small (1–2 pages). Each page is roughly 20–40 sentences.
            </p>

            <div className="wizard-actions">
              <button className="btn" onClick={() => setInfo(null)} disabled={busy}>
                Change paper
              </button>
              <button
                className="btn btn-primary"
                onClick={doImport}
                disabled={
                  busy ||
                  !Number.isInteger(pageStart) ||
                  !Number.isInteger(pageEnd) ||
                  pageStart < 1 ||
                  pageEnd > info.numPages ||
                  pageEnd < pageStart
                }
              >
                {busy ? 'Importing…' : `Import pages ${pageStart}–${pageEnd}`}
              </button>
            </div>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}
      </div>
    </div>
  );
}
