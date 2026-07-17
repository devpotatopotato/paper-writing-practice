import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Paper preview: the original PDF rendered page by page, with blur overlays
 * covering every sentence the user hasn't written yet. The current sentence
 * is highlighted; written sentences are clickable to revisit.
 */
export default function Preview({ paper, current, onJump }) {
  const total = paper.sentences.length;
  const hasPdfLayout = Boolean(paper.pages?.length && paper.sentences[0]?.rects);

  return (
    <section className="panel-paper">
      <div className="preview-toolbar">
        <span>Paper preview</span>
        <span className="hint-text">
          {Math.min(current, total)}/{total} written · click a written sentence to revisit
        </span>
      </div>
      <div className="preview-scroll">
        {hasPdfLayout ? (
          <PdfSheet paper={paper} current={current} onJump={onJump} />
        ) : (
          <p className="hint-text" style={{ textAlign: 'center', marginTop: 40 }}>
            This paper was imported with an older version — delete and re-import it to see
            the original PDF here.
          </p>
        )}
      </div>
    </section>
  );
}

function PdfSheet({ paper, current, onJump }) {
  const [doc, setDoc] = useState(null);
  const [width, setWidth] = useState(0);
  const hostRef = useRef(null);

  // Load the PDF once per paper.
  useEffect(() => {
    let cancelled = false;
    let loaded;
    pdfjs.getDocument(`/api/papers/${paper.id}/pdf`).promise.then((d) => {
      loaded = d;
      if (cancelled) d.destroy();
      else setDoc(d);
    });
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [paper.id]);

  // Track the panel width so pages rescale with the window.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sentence rects grouped by page number.
  const rectsByPage = useMemo(() => {
    const map = new Map();
    for (const s of paper.sentences) {
      for (const r of s.rects || []) {
        if (!map.has(r.page)) map.set(r.page, []);
        map.get(r.page).push({ ...r, idx: s.idx });
      }
    }
    return map;
  }, [paper.sentences]);

  // Non-practice masks (headings, equations, footnotes…) grouped by page.
  const masksByPage = useMemo(() => {
    const map = new Map();
    for (const m of paper.masks || []) {
      for (const r of m.rects) {
        if (!map.has(r.page)) map.set(r.page, []);
        map.get(r.page).push({ ...r, revealAt: m.revealAt });
      }
    }
    return map;
  }, [paper.masks]);

  return (
    <div className="pdf-host" ref={hostRef}>
      {doc &&
        width > 0 &&
        paper.pages.map((p) => (
          <PdfPage
            key={p.page}
            doc={doc}
            pageInfo={p}
            cssWidth={Math.min(width, 900)}
            rects={rectsByPage.get(p.page) || []}
            masks={masksByPage.get(p.page) || []}
            current={current}
            onJump={onJump}
          />
        ))}
      {!doc && <div className="hint-text" style={{ textAlign: 'center', marginTop: 40 }}>Loading PDF…</div>}
    </div>
  );
}

function PdfPage({ doc, pageInfo, cssWidth, rects, masks, current, onJump }) {
  const canvasRef = useRef(null);
  const currentRef = useRef(null);
  const scale = cssWidth / pageInfo.width;
  const cssHeight = pageInfo.height * scale;

  useEffect(() => {
    let cancelled = false;
    let task;
    doc.getPage(pageInfo.page).then((page) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      task.promise.catch(() => {/* cancelled mid-render */});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageInfo.page, scale]);

  // Scroll the current sentence's first rect into view.
  const firstCurrent = rects.find((r) => r.idx === current);
  useEffect(() => {
    if (firstCurrent) {
      currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [current, Boolean(firstCurrent)]);

  let currentSeen = false;

  return (
    <div className="pdf-page" style={{ width: cssWidth, height: cssHeight }}>
      <canvas ref={canvasRef} style={{ width: cssWidth, height: cssHeight }} />
      {rects.map((r, i) => {
        const state = r.idx < current ? 'done' : r.idx === current ? 'current' : 'future';
        const isAnchor = state === 'current' && !currentSeen;
        if (isAnchor) currentSeen = true;
        // r.y is the text baseline in PDF coords (origin bottom-left). Blur
        // overlays get horizontal padding so estimation error never leaves a
        // readable sliver between sentences.
        const pad = state === 'done' ? 0 : 2.5;
        const style = {
          left: (r.x - pad) * scale,
          top: (pageInfo.height - r.y - r.h * 0.95) * scale,
          width: (r.w + 2 * pad) * scale,
          height: r.h * 1.3 * scale,
        };
        return (
          <div
            key={i}
            ref={isAnchor ? currentRef : null}
            className={`pdf-overlay ${state}`}
            style={style}
            onClick={state === 'done' ? () => onJump(r.idx) : undefined}
            title={state === 'done' ? 'Click to revisit this sentence' : undefined}
          />
        );
      })}
      {masks.map(
        (r, i) =>
          current < r.revealAt && (
            <div
              key={`m${i}`}
              className="pdf-overlay future"
              style={{
                left: (r.x - 2.5) * scale,
                top: (pageInfo.height - r.y - r.h * 0.95) * scale,
                width: (r.w + 5) * scale,
                height: r.h * 1.3 * scale,
              }}
            />
          )
      )}
      <div className="pdf-page-num">{pageInfo.page}</div>
    </div>
  );
}
