const CACHE_NAME = 'x1-shell-v2';

// Only the application shell and built assets belong to this cache, never file APIs.
function cacheableRequest(request) {
  const url = new URL(request.url), scope = new URL(self.registration.scope);
  if (request.method !== 'GET' || url.origin !== scope.origin || request.headers.has('Authorization')) return false;
  if (request.mode === 'navigate') return !url.search && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html');
  return url.pathname.startsWith(new URL('./assets/', scope).pathname);
}
function cacheableResponse(request, response) {
  return response.ok && (request.mode !== 'navigate' || response.headers.get('Content-Type')?.includes('text/html'));
}
async function appResponse(request) {
  try { return await fetch(request, { cache: 'no-cache' }); }
  catch { return (await (await caches.open(CACHE_NAME)).match(request)) ?? Response.error(); }
}
async function remember(request, response) {
  if (!cacheableResponse(request, response)) return;
  try { await (await caches.open(CACHE_NAME)).put(request, response); }
  catch { /* Cache quota or availability must not turn a successful load into a failure. */ }
}
self.addEventListener('fetch', event => {
  if (!cacheableRequest(event.request)) return;
  const response = appResponse(event.request);
  // Register lifetime work during dispatch, before the asynchronous fetch settles.
  const saved = response.then(value => remember(event.request, value.clone()));
  event.waitUntil(saved);
  event.respondWith(response);
});

self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await caches.delete('x1-v1');
    await self.clients.claim();
  })());
});
