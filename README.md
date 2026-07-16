# Paper Writing Practice

Practice English academic writing (for Korean natives): import an arXiv paper, read the
Korean translation of each sentence, and rewrite the original English sentence yourself —
Overleaf-style, filling in the paper as you go.

## Setup

```bash
npm install        # installs server + client deps
npm run dev        # server on :5175, client on :5173
```

Open http://localhost:5173. `GEMINI_API_KEY` must be set in `.env` (it already is).

## How it works

1. **Import** — paste an arXiv link, pick the page range you want to practice.
2. The server downloads the PDF, extracts those pages, splits them into sentences,
   and translates each sentence into Korean with Gemini (in the background, with a
   progress bar).
3. **Practice** — left panel shows the Korean translation; you write the English
   sentence. `Enter` checks your attempt against the original with a word-level diff.
   The 💡 hint button flashes the original sentence for 3 seconds.
4. **Preview** — the right panel renders the paper like a real sheet: sentences you've
   written are visible, the current one is highlighted ("you are here"), the rest is
   blurred. Click any written sentence to revisit it.

## Persistence

Everything (paper, translations, your attempts, current position) is saved as JSON in
`data/` in this project, so restarting the server resumes exactly where you left off.
