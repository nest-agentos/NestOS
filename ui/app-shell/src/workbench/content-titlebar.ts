import {mountTitleBar as mountSharedTitleBar, navigationButton,
    type ContentTitleBarParts, type ContentTitleBarState} from '@nestos/ui-common';
import {installNavigationButtonPresentation} from '@nestos/ui-common-adapter';
import {ACTION_ICONS, FILE_ICONS, t} from '@nestos/common';
import {navigateWorkspaceBack} from '../navigation/page-history';
import {decorateButton} from './controls';
const mounted = new WeakMap<HTMLElement, () => void>();

function mountPin(parts: ContentTitleBarParts, toggle?: () => void) {
    const menu = parts.menu;
    const body = parts.menuBody ?? menu?.querySelector(':scope > div');
    if (!toggle || !(menu instanceof HTMLDetailsElement) || !body) return;
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'workbench-menu-pin';
    button.onclick = () => {toggle(); menu.open = false; menu.querySelector('summary')?.focus();};
    body.prepend(button);
    return {
        update(pinned?: boolean) {
            button.hidden = pinned === undefined;
            const pressed = String(!!pinned);
            if (button.getAttribute('aria-pressed') === pressed) return;
            decorateButton(button, FILE_ICONS.pin, t(pinned ? 'workbench.unpin' : 'workbench.pin'));
            button.setAttribute('aria-pressed', pressed);
        },
        destroy: () => button.remove(),
    };
}

/** The shell supplies navigation policy; ui-common owns the complete visual layout. */
export function mountContentTitleBar(container: HTMLElement, parts: ContentTitleBarParts, windows: (at: HTMLElement) => () => void, navigate?: () => void, togglePin?: () => void) {
    mounted.get(container)?.();
    const releases: Array<() => void> = [];
    const back = parts.back ?? navigationButton({icon: ACTION_ICONS.back, label: t('workspace.mobile.back'), run: () => navigate ? navigate() : navigateWorkspaceBack(container)});
    back.classList.add('ui-nav-button');
    back.classList.add('workbench-content-back');
    if (!parts.back) releases.push(installNavigationButtonPresentation(back as HTMLButtonElement));
    const slot = document.createElement('span'); slot.className = 'ui-content-titlebar__actions'; releases.push(windows(slot));
    const summary = parts.menu?.querySelector('summary');
    summary?.classList.add('ui-nav-button');
    const pin = mountPin(parts, togglePin);
    if (pin) releases.push(pin.destroy);
    const view = mountSharedTitleBar(container, {...parts, back, trailing: [...(parts.trailing ?? []), slot], statePresentation: {
        dirtyLabel: t('workspace.titlebar.unsaved'),
    }});
    const previous = container.dataset.editorMobileNavigation; container.dataset.editorMobileNavigation = 'embedded';
    let closed = false;
    const destroy = () => {
        if (closed) return; closed = true;
        releases.forEach(release => release()); view.destroy(); summary?.classList.remove('ui-nav-button'); back.classList.remove('workbench-content-back');
        if (previous === undefined) delete container.dataset.editorMobileNavigation; else container.dataset.editorMobileNavigation = previous;
        if (mounted.get(container) === destroy) mounted.delete(container);
    };
    mounted.set(container, destroy);
    return {update(state: ContentTitleBarState & {pinned?: boolean}) {if (!closed) {view.update(state); pin?.update(state.pinned);}}, destroy};
}
