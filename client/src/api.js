async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  inspect: (url) => request('/api/inspect', json('POST', { url })),
  importPaper: (arxivId, title, pageStart, pageEnd) =>
    request('/api/papers', json('POST', { arxivId, title, pageStart, pageEnd })),
  listPapers: () => request('/api/papers'),
  getPaper: (id) => request(`/api/papers/${id}`),
  retranslate: (id) => request(`/api/papers/${id}/retranslate`, { method: 'POST' }),
  saveProgress: (id, progress) => request(`/api/papers/${id}/progress`, json('PUT', progress)),
  deletePaper: (id) => request(`/api/papers/${id}`, { method: 'DELETE' }),
};
