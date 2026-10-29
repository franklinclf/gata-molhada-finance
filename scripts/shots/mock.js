// Answers the app's /api requests from invented data, so a page can be opened straight from disk and photographed.
(() => {
  const data = window.__FIXTURES__;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname;
    if ((init && init.method && init.method !== 'GET') || (init && init.method === 'DELETE')) return json({ ok: true });
    if (/^\/api\/transactions\/[^/]+\/candidates$/.test(path)) return json(data.responses.candidates);
    if (/^\/api\/transactions\/[^/]+$/.test(path)) return json(data.responses.detail);
    if (path in data.responses) return json(data.responses[path]);
    return json({ error: 'not_found' }, 404);
  };
})();

// A route can ask for a click after the page has drawn (`__click=<selector>` in the hash), to photograph an open dropdown.
window.addEventListener('load', () => {
  setTimeout(() => {
    const m = /__click=([^&]+)/.exec(location.hash);
    if (m) document.querySelector(decodeURIComponent(m[1]))?.click();
  }, 1800);
});

