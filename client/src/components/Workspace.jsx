import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { diffWords, normalizeSentence } from '../diff.js';
import Preview from './Preview.jsx';

const HINT_SECONDS = 3;
const STREAK_GOAL = 5; // perfect writes required to move on

export default function Workspace({ paperId, onExit }) {
  const [paper, setPaper] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState({});
  const [current, setCurrent] = useState(0);
  const [text, setText] = useState('');
  const [result, setResult] = useState(null); // diff result after "Check"
  const [hintLeft, setHintLeft] = useState(0); // seconds of hint remaining
  const [showKo, setShowKo] = useState(true); // Korean translation visible?
  const [streak, setStreak] = useState(0); // total perfect writes of the current sentence (misses don't reset it)
  const [flash, setFlash] = useState(0); // >0 briefly after a perfect write, to show feedback
  const flashTimer = useRef(null);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);
  const hintTimer = useRef(null);

  // Load the paper; keep polling while translation is still running.
  useEffect(() => {
    let stop = false;
    let timer;
    const load = async () => {
      try {
        const p = await api.getPaper(paperId);
        if (stop) return;
        setPaper(p);
        setAttempts(p.progress.attempts || {});
        setCurrent(p.progress.current || 0);
        if (p.status === 'translating') timer = setTimeout(load, 1500);
      } catch (err) {
        if (!stop) setError(err.message);
      }
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [paperId]);

  const sentences = paper?.sentences || [];
  const sentence = sentences[current];
  const done = paper && current >= sentences.length;

  const persist = useCallback(
    async (nextCurrent, nextAttempts) => {
      setSaving(true);
      try {
        await api.saveProgress(paperId, { current: nextCurrent, attempts: nextAttempts });
      } catch {
        /* offline save failures are non-fatal; next save retries */
      } finally {
        setSaving(false);
      }
    },
    [paperId]
  );

  // Reset the editor when moving to another sentence.
  useEffect(() => {
    setResult(null);
    setHintLeft(0);
    setFlash(0);
    clearInterval(hintTimer.current);
    clearTimeout(flashTimer.current);
    const prev = attempts[current];
    setStreak(prev && !prev.done ? prev.correct || 0 : 0);
    setText(prev && !prev.done ? prev.text || '' : '');
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, paper?.id]);

  const check = () => {
    if (!sentence || !text.trim()) return;
    const diff = diffWords(text, sentence.en);
    const perfect = normalizeSentence(text) === normalizeSentence(sentence.en);
    const prev = attempts[current] || { tries: 0, hints: 0 };
    const nextAttempts = {
      ...attempts,
      [current]: { ...prev, text, tries: (prev.tries || 0) + 1, score: diff.score, perfect },
    };
    setAttempts(nextAttempts);
    if (perfect) {
      // No result box on a perfect write: clear the input and go again.
      // After STREAK_GOAL perfect writes in total, move to the next sentence.
      setResult(null);
      const s = streak + 1;
      nextAttempts[current] = { ...nextAttempts[current], correct: s };
      if (s >= STREAK_GOAL) {
        const doneAttempts = {
          ...nextAttempts,
          [current]: { ...nextAttempts[current], done: true },
        };
        const nextCurrent = Math.min(current + 1, sentences.length);
        setAttempts(doneAttempts);
        setCurrent(nextCurrent);
        persist(nextCurrent, doneAttempts);
        return;
      }
      setStreak(s);
      setText('');
      setFlash(s);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(0), 1400);
      textareaRef.current?.focus();
      persist(current, nextAttempts);
    } else {
      // A miss shows the diff; the correct count is kept.
      setResult({ ...diff, perfect });
      persist(current, nextAttempts);
    }
  };

  const next = () => {
    const prev = attempts[current] || {};
    const nextAttempts = { ...attempts, [current]: { ...prev, text, done: true } };
    const nextCurrent = Math.min(current + 1, sentences.length);
    setAttempts(nextAttempts);
    setCurrent(nextCurrent);
    persist(nextCurrent, nextAttempts);
  };

  const showHint = () => {
    const prev = attempts[current] || {};
    const nextAttempts = { ...attempts, [current]: { ...prev, hints: (prev.hints || 0) + 1 } };
    setAttempts(nextAttempts);
    persist(current, nextAttempts);
    clearInterval(hintTimer.current);
    setHintLeft(HINT_SECONDS);
    hintTimer.current = setInterval(() => {
      setHintLeft((s) => {
        if (s <= 1) {
          clearInterval(hintTimer.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  const jumpTo = (idx) => {
    if (idx > current) return; // can only revisit what you've already written
    setCurrent(idx);
    persist(idx, attempts);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      check();
    }
  };

  const stats = useMemo(() => {
    const vals = Object.values(attempts).filter((a) => a.done);
    return {
      perfect: vals.filter((a) => a.perfect).length,
      hints: Object.values(attempts).reduce((n, a) => n + (a.hints || 0), 0),
    };
  }, [attempts]);

  if (error) {
    return (
      <div className="app-loading">
        <div className="error-banner">{error}</div>
        <button className="btn" onClick={onExit}>← Back to library</button>
      </div>
    );
  }
  if (!paper) return <div className="app-loading">Loading paper…</div>;

  if (paper.status === 'error') {
    return (
      <div className="app-loading">
        <div className="error-banner">Translation failed: {paper.error}</div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn" onClick={onExit}>← Back</button>
          <button
            className="btn btn-primary"
            onClick={() => api.retranslate(paperId).then(() => location.reload())}
          >
            Retry translation
          </button>
        </div>
      </div>
    );
  }

  if (paper.status === 'translating') {
    const pct = Math.round((100 * (paper.translatedCount || 0)) / sentences.length);
    return (
      <div className="app-loading">
        <div className="translating-card">
          <div className="spinner" />
          <h3>Translating with Codex…</h3>
          <p className="hint-text">
            {paper.translatedCount || 0} / {sentences.length} sentences
          </p>
          <div className="progress-track big">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    );
  }

  const progressPct = Math.round((100 * current) / sentences.length);

  return (
    <div className="workspace">
      <header className="ws-header">
        <button className="btn-link" onClick={onExit}>← Library</button>
        <div className="ws-title">
          <strong>{paper.title}</strong>
          <span className="ws-subtitle">
            {paper.arxivId} · pages {paper.pageStart}–{paper.pageEnd}
          </span>
        </div>
        <div className="ws-position">
          {done ? (
            <span>Completed 🎉</span>
          ) : (
            <span>
              Sentence <strong>{current + 1}</strong> / {sentences.length} · Page {sentence.page}
            </span>
          )}
          <span className={`save-dot ${saving ? 'saving' : ''}`} title="Progress auto-saved">
            {saving ? 'saving…' : 'saved'}
          </span>
        </div>
      </header>
      <div className="ws-progress">
        <div className="progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      <div className="ws-panels">
        {/* ------- left: writing panel ------- */}
        <section className="panel-write">
          {done ? (
            <div className="complete-card fade-in">
              <div className="empty-icon">🏆</div>
              <h2>You finished this section!</h2>
              <p>
                {sentences.length} sentences written · {stats.perfect} perfect on first check ·{' '}
                {stats.hints} hints used
              </p>
              <div className="wizard-actions">
                <button className="btn" onClick={() => jumpTo(0)}>Practice again</button>
                <button className="btn btn-primary" onClick={onExit}>Back to library</button>
              </div>
            </div>
          ) : (
            <>
              <div className="ko-card fade-in" key={current}>
                <div className="ko-label">
                  Korean translation — write this sentence in English
                  <span className="ko-actions">
                    <button
                      className="btn-link ko-toggle"
                      onClick={() => setShowKo((v) => !v)}
                      title={showKo ? 'Hide the Korean translation' : 'Show the Korean translation'}
                    >
                      {showKo ? '🙈 Hide' : '👁 Show'}
                    </button>
                    <span className="ko-count">#{current + 1}</span>
                  </span>
                </div>
                <p className={`ko-sentence ${showKo ? '' : 'ko-hidden'}`}>
                  {sentence.ko || '(no translation)'}
                </p>
                <div className={`hint-zone ${hintLeft > 0 ? 'revealed' : ''}`}>
                  {hintLeft > 0 ? (
                    <p className="hint-sentence">
                      {sentence.en}
                      <span className="hint-count">{hintLeft}s</span>
                    </p>
                  ) : (
                    <button className="btn btn-ghost" onClick={showHint}>
                      💡 Hint — show the original for {HINT_SECONDS}s
                    </button>
                  )}
                </div>
              </div>

              <textarea
                ref={textareaRef}
                className="write-area"
                placeholder="Write the English sentence here… (Enter to check, Shift+Enter for newline)"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                rows={4}
                spellCheck={false}
              />

              <div className="write-actions">
                <button className="btn" onClick={() => jumpTo(current - 1)} disabled={current === 0}>
                  ← Prev
                </button>
                <button className="btn btn-primary" onClick={check} disabled={!text.trim()}>
                  Check ↵
                </button>
                <button className="btn" onClick={next}>
                  Skip / Next →
                </button>
                <span className="streak" title={`Write it perfectly ${STREAK_GOAL} times to move on`}>
                  {Array.from({ length: STREAK_GOAL }, (_, i) => (
                    <span key={i} className={`streak-dot ${i < streak ? 'on' : ''}`} />
                  ))}
                  <span className="streak-count">{streak}/{STREAK_GOAL}</span>
                  {flash > 0 && (
                    <span key={flash} className="streak-flash fade-in">✓ Correct — write it again!</span>
                  )}
                </span>
              </div>

              {result && (
                <div className="result-card fade-in">
                  <div className="result-head">
                    <span className="result-badge">
                      {Math.round(result.score * 100)}% word match
                    </span>
                    <span className="hint-text">green = matched words, red = differences</span>
                  </div>

                  <div className="diff-block">
                    <div className="diff-label">Your sentence</div>
                    <p className="diff-line">
                      {result.user.map((t, i) => (
                        <span key={i} className={t.ok ? 'w-ok' : 'w-bad'}>
                          {t.word}{' '}
                        </span>
                      ))}
                    </p>
                  </div>

                  <div className="write-actions">
                    <button
                      className="btn"
                      onClick={() => {
                        setResult(null);
                        textareaRef.current?.focus();
                      }}
                    >
                      ✏️ Try again
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ------- right: the paper, with unwritten sentences blurred ------- */}
        <Preview paper={paper} current={current} onJump={jumpTo} />
      </div>
    </div>
  );
}
