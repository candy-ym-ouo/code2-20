async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.issues = body.issues || [];
    throw error;
  }
  return body;
}

export const gameApi = {
  getState: () => request('/api/game'),
  preview: (assignments) => request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments })
  }),
  advance: (assignments, expectedRevision) => request('/api/game/day/advance', {
    method: 'POST',
    body: JSON.stringify({ assignments, expectedRevision })
  }),
  reset: (seed) => request('/api/game/reset', {
    method: 'POST',
    body: JSON.stringify(seed === undefined || seed === null ? {} : { seed })
  })
};

export const savesApi = {
  list: () => request('/api/saves'),
  create: ({ name, seed } = {}) => request('/api/saves', {
    method: 'POST',
    body: JSON.stringify({ name, seed })
  }),
  switch: (slotId) => request(`/api/saves/${encodeURIComponent(slotId)}/switch`, {
    method: 'POST',
    body: '{}'
  }),
  remove: (slotId) => request(`/api/saves/${encodeURIComponent(slotId)}`, { method: 'DELETE' }),
  listVersions: (slotId) => request(`/api/saves/${encodeURIComponent(slotId)}/versions`),
  restore: (slotId, versionId) => request(`/api/saves/${encodeURIComponent(slotId)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ versionId })
  })
};
