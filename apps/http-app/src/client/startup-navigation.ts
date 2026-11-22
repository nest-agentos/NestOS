import {createModuleLogger, randomUUID} from '@nestos/common/startup';

const log = createModuleLogger('startup-navigation');

/** Select a different bootstrap target before the full workspace router takes over. */
export function installStartupNavigation(reload = () => location.reload()): () => void {
    const controller = new AbortController();
    document.addEventListener('click', event => {
        if (event.defaultPrevented || !(event.target instanceof Element)) return;
        const target = event.target.closest<HTMLButtonElement>('.app-nav-btn[data-target]')?.dataset.target;
        if (!target?.endsWith('-workspace')) return;
        const slug = target === 'llm-workspace' ? 'workbench' : target === 'email-workspace' ? 'emails' : target.slice(0, -'-workspace'.length);
        event.preventDefault();
        const started = performance.now(), operationId = randomUUID();
        const hash = '#/' + encodeURIComponent(slug);
        if (location.hash !== hash) history.pushState(null, '', hash);
        log.info('navigation.startup.selected', {operation: 'navigation.startup', stage: 'select', result: 'success',
            operationId, workspace: slug, durationMs: Math.round(performance.now() - started)});
        reload();
    }, {signal: controller.signal});
    return () => controller.abort();
}
