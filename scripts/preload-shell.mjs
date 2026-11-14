/** Fetch the unconditional shell with the document; optional editors stay lazy. */
export function preloadShell(entrySuffix) {
    return {name: 'nestos-preload-shell', transformIndexHtml: {order: 'post', handler(_html, context) {
        const bundle = context.bundle;
        if (!bundle) return;
        const shell = Object.values(bundle).find(chunk => chunk.type === 'chunk' && (chunk.facadeModuleId?.endsWith(entrySuffix) || Object.keys(chunk.modules ?? {}).some(id => id.endsWith(entrySuffix))));
        if (!shell) return;
        const visited = new Set(), tags = [];
        const visit = name => {
            if (visited.has(name)) return;
            visited.add(name);
            const chunk = bundle[name];
            if (chunk?.type !== 'chunk') return;
            if (!chunk.isEntry) {
                tags.push({tag: 'link', attrs: {rel: 'modulepreload', crossorigin: '', href: './' + name}, injectTo: 'head'});
                for (const css of chunk.viteMetadata?.importedCss ?? []) if (!visited.has(css)) {
                    visited.add(css); tags.push({tag: 'link', attrs: {rel: 'preload', as: 'style', crossorigin: '', href: './' + css}, injectTo: 'head'});
                }
            }
            for (const dependency of chunk.imports) visit(dependency);
        };
        visit(shell.fileName);
        return tags;
    }}};
}
