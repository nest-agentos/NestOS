import {MOBILE_NAVIGATION_QUERY} from '@nestos/ui-common-adapter';
/** Reports the sidebar surface; each workspace owns the visibility of its local views. */
export function observeNavigationVisibility(layout: HTMLElement, sidebar: HTMLElement, changed: (visible: boolean) => void, afterContentPaint = false): () => void {
    const workspace = layout.closest('.workspace-view'), media = window.matchMedia?.(MOBILE_NAVIGATION_QUERY);
    let previous: boolean | undefined;
    let frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = afterContentPaint && !media?.matches && document.visibilityState !== 'hidden';
    const sync = () => {
        const visible = !!workspace?.classList.contains('active') && !sidebar.classList.contains('is-collapsed')
            && !sidebar.hidden
            && (!media?.matches || layout.dataset.mobileView === 'list');
        if (visible && waiting && !media?.matches) {
            frame ??= requestAnimationFrame(() => {
                timer = setTimeout(() => {waiting = false; sync();}, 0);
            });
            return;
        }
        if (previous !== visible) { previous = visible; changed(visible); }
    };
    const observer = new MutationObserver(sync);
    for (const element of [workspace, layout, sidebar]) if (element) observer.observe(element, {attributes: true, attributeFilter: ['class', 'data-mobile-view']});
    observer.observe(sidebar, {subtree: true, attributes: true, attributeFilter: ['class', 'hidden']});
    media?.addEventListener?.('change', sync); sync();
    return () => {
        observer.disconnect(); media?.removeEventListener?.('change', sync);
        if (frame !== undefined) cancelAnimationFrame(frame);
        clearTimeout(timer);
    };
}
