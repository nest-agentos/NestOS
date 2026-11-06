// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {SessionRenderer} from '../../llm-ui-adapter/src/components/history/SessionRenderer';
import {promptWindowName} from '../../llm-ui-adapter/src/components/history/window-outline-name';
const renderers: SessionRenderer[] = [];
afterEach(async () => {for (const view of renderers.splice(0)) await view.destroy(); document.body.replaceChildren(); vi.restoreAllMocks();});
it('indexes only configured windows, retains identity across duplicate names, updates and removals', async () => {
    const host = document.createElement('div'); document.body.append(host);
    vi.spyOn(SessionRenderer.prototype as never, 'mountUserEditor' as never).mockImplementation(() => {});
    const view = new SessionRenderer(host, {windowName: promptWindowName}); renderers.push(view);
    const group = (id: string, content = 'Same', role = 'user') => ({id, content, role, timestamp: 1000} as never);
    view.appendSession(group('first'), true); view.appendSession(group('second'), false); view.appendSession(group('reply', 'Answer', 'assistant'), false);
    const node = view.getSessionElement('first'); expect(view.getWindowOutline().map(item => item.id)).toEqual(['first', 'second']);
    expect(view.getWindowOutline()[0].label).toBe(view.getWindowOutline()[1].label);
    expect(view.revealWindow('first')).toBe(node); expect(node?.classList.contains('is-collapsed')).toBe(false);
    await view.reconcileSessions([group('first', 'Changed'), group('second'), group('reply', 'Answer', 'assistant')]);
    expect(view.getWindowOutline()[0].label).toContain('Changed'); expect(view.getSessionElement('first')).toBe(node);
    view.removeMessages(['first'], true); expect(view.getWindowOutline().map(item => item.id)).toEqual(['second']);
    expect(() => view.revealWindow('first')).toThrow(); view.clear(); expect(view.getWindowOutline()).toEqual([]);
});
it('leaves unconfigured SessionRenderer windows out of the registry', () => {
    const host = document.createElement('div'); document.body.append(host); const view = new SessionRenderer(host, {}); renderers.push(view);
    view.appendSession({id: 'reply', role: 'assistant', content: ''} as never, false); expect(view.getWindowOutline()).toEqual([]);
});
