// Word-level comparison between the user's attempt and the original sentence.

export function tokenize(s) {
  return s.trim().split(/\s+/).filter(Boolean);
}

const normalizeWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function normalizeSentence(s) {
  return tokenize(s).map(normalizeWord).filter(Boolean).join(' ');
}

/**
 * LCS diff. Returns { user: [{word, ok}], original: [{word, ok}], score }.
 * `ok` marks words that match the other side; score is matches / max length.
 */
export function diffWords(userText, originalText) {
  const a = tokenize(userText);
  const b = tokenize(originalText);
  const an = a.map(normalizeWord);
  const bn = b.map(normalizeWord);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = an[i] && an[i] === bn[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const userMarks = a.map((word) => ({ word, ok: false }));
  const origMarks = b.map((word) => ({ word, ok: false }));
  let i = 0, j = 0, matches = 0;
  while (i < n && j < m) {
    if (an[i] && an[i] === bn[j]) {
      userMarks[i].ok = true;
      origMarks[j].ok = true;
      matches++;
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const score = m === 0 ? 0 : matches / Math.max(n, m);
  return { user: userMarks, original: origMarks, score };
}
