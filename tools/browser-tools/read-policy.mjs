// The managed NestOS origin serves both query and mutation RPCs over POST.
const getPaths = new Set(['/', '/api/health', '/api/identity', '/api/application/events']);
const viewReads = new Set(['bootstrap', 'bootstrap-data', 'updates-read', 'queries', 'bindings', 'close']);

export function nestosReadRequest(request, url) {
    if (request.method() === 'GET' || request.method() === 'HEAD') {
        return getPaths.has(url.pathname) || url.pathname.startsWith('/assets/')
            || /^\/(favicon\.ico|manifest\.webmanifest)$/.test(url.pathname);
    }
    if (request.method() !== 'POST') return false;
    try {
        if (url.pathname === '/api/application/files') {
            const file = JSON.parse(decodeURIComponent(request.headers()['x-view-call'] ?? ''));
            return file?.method === 'readContent' && !request.postData();
        }
        if (url.pathname !== '/api/application') return false;
        return viewReads.has(request.postDataJSON()?.kind);
    } catch {
        return false;
    }
}
