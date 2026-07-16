import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Library from './components/Library.jsx';
import ImportWizard from './components/ImportWizard.jsx';
import Workspace from './components/Workspace.jsx';

const LAST_PAPER_KEY = 'writing-practice:last-paper';

export default function App() {
  const [view, setView] = useState({ name: 'loading' });

  const openLibrary = useCallback(() => {
    localStorage.removeItem(LAST_PAPER_KEY);
    setView({ name: 'library' });
  }, []);

  const openPaper = useCallback((id) => {
    localStorage.setItem(LAST_PAPER_KEY, id);
    setView({ name: 'workspace', paperId: id });
  }, []);

  // Resume where the user left off, even across server restarts.
  useEffect(() => {
    const last = localStorage.getItem(LAST_PAPER_KEY);
    if (!last) return setView({ name: 'library' });
    api
      .getPaper(last)
      .then(() => setView({ name: 'workspace', paperId: last }))
      .catch(() => setView({ name: 'library' }));
  }, []);

  if (view.name === 'loading') {
    return <div className="app-loading">Loading…</div>;
  }
  if (view.name === 'import') {
    return <ImportWizard onCancel={openLibrary} onImported={openPaper} />;
  }
  if (view.name === 'workspace') {
    return <Workspace paperId={view.paperId} onExit={openLibrary} />;
  }
  return <Library onOpen={openPaper} onNew={() => setView({ name: 'import' })} />;
}
