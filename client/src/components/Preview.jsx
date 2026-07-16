import { useEffect, useMemo, useRef } from 'react';

/**
 * Overleaf-style preview: the paper fills in as the user writes.
 * Written sentences are visible, the current one is highlighted,
 * everything ahead is blurred out.
 */
export default function Preview({ paper, current, onJump }) {
  const currentRef = useRef(null);

  const pages = useMemo(() => {
    const byPage = new Map();
    for (const s of paper.sentences) {
      if (!byPage.has(s.page)) byPage.set(s.page, []);
      byPage.get(s.page).push(s);
    }
    return [...byPage.entries()];
  }, [paper.sentences]);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [current]);

  const total = paper.sentences.length;

  return (
    <section className="panel-right">
      <div className="preview-toolbar">
        <span>Paper preview</span>
        <span className="hint-text">
          {Math.min(current, total)}/{total} written · click a written sentence to revisit
        </span>
      </div>
      <div className="preview-scroll">
        <div className="paper-sheet">
          <h2 className="sheet-title">{paper.title}</h2>
          {pages.map(([pageNum, sents]) => (
            <div key={pageNum} className="sheet-page">
              <div className="sheet-page-label">— page {pageNum} —</div>
              <p className="sheet-text">
                {sents.map((s) => {
                  const state = s.idx < current ? 'done' : s.idx === current ? 'current' : 'future';
                  return (
                    <span
                      key={s.idx}
                      ref={state === 'current' ? currentRef : null}
                      className={`sheet-sentence ${state}`}
                      onClick={state === 'done' ? () => onJump(s.idx) : undefined}
                      title={state === 'done' ? 'Click to revisit this sentence' : undefined}
                    >
                      {s.en}{' '}
                      {state === 'current' && <span className="here-badge">✍️ you are here</span>}
                    </span>
                  );
                })}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
