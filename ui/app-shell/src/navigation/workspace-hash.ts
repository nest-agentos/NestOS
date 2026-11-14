/** Decode the shell envelope once; folder segments keep their own URI encoding. */
export function parseWorkspaceHash(hash: string, fallback: string): { slug: string; resource?: string } {
    const [slug, ...segments] = hash.replace(/^#\/?/, '').split('/');
    const raw = segments.join('/');
    let resource = raw;
    try { resource = decodeURIComponent(raw); } catch { /* Let the workbench report a malformed address. */ }
    return { slug: (slug === 'minds' ? 'notes' : slug) || fallback, resource: resource && resource !== 'new' ? resource : undefined };
}

