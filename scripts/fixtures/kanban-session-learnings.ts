import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {KanbanWorkbench} from '@nestos/kanban-ui';
import type {KanbanCommand} from '@nestos/kanban/contracts';
import {registerSessionLearnings} from '../../backend/app-core/src/kanban/session-learnings';
import {channelDigest} from '../../backend/app-core/src/run/channel-protocol';

const wait = async (ready: () => boolean) => {
    for (let n = 0; n < 500; n++) {if (ready()) return; await new Promise(resolve => setTimeout(resolve, 10));}
    throw Error('LEARNING_UI_NOT_READY');
};
async function run() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const store = await SeqKanbanStore.open(fs), actor = {kind: 'human' as const, id: 'reviewer'};
    const service = createKanbanModule({store, actor, authorize: async () => {}});
    await service.create({id: 'board', title: 'Session learnings', scope: {kind: 'system'}, policy: {requireEstimate: false},
        members: [{...actor, responsibility: 'Review', roles: ['coordinator', 'reviewer', 'worker']}]});
    let sequence = 0;
    const command = async (command: KanbanCommand) => service.execute('board', {operationId: 'seed-' + ++sequence,
        expectedRevision: (await service.read('board')).revision, command});
    await command({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true,
        items: Array.from({length: 20}, (_, index) => ({id: 'task-' + index, title: 'Task ' + index,
            responsibility: 'Work', acceptance: 'Evidence', assignee: actor, dependsOn: [], outputs: []}))}});
    await command({type: 'prepare-dispatch', itemId: 'task-0', dispatchId: 'execution'});
    await command({type: 'link-reference', itemId: 'task-0', reference: {system: 'nestos-execution-session', id: 'source-session', revision: 'execution'}});
    const journal = new KanbanAutomationJournal(fs); await journal.open();
    await seedLearning(service, journal, command);
    await measureView(service);
    await manager.dispose();
}
async function seedLearning(service: ReturnType<typeof createKanbanModule>, journal: KanbanAutomationJournal, command: (value: KanbanCommand) => Promise<unknown>) {
    const row = {id: 'receipt', itemId: 'task-0', event: 'Lost receipt', handling: 'Inspect original operation',
        reason: 'Avoid duplicate side effects', result: 'Recovered once', conditions: 'Stable operation identity'};
    const payload = {learnings: [row]};
    if (location.hash !== '#baseline') {
        await registerSessionLearnings({boardId: 'board', sessionId: 'source-session', messageId: 'result', service, journal, payload}); return;
    }
    // Seed identical persisted data through the existing record command for a read-path baseline.
    await command({type: 'append-record', record: {id: 'learning-' + channelDigest(['board', 'source-session', row.itemId, row.id]),
        kind: 'log', title: row.event, content: [row.event, row.handling, row.result, row.conditions].join('\n\n'),
        rationale: row.reason, itemIds: [row.itemId], sources: [{sessionId: 'source-session', messageId: 'result', revision: channelDigest(payload), role: 'assistant'}]}});
}
async function measureView(service: ReturnType<typeof createKanbanModule>) {
    let calls: string[] = [], opened = '';
    const metrics: unknown[] = [];
    const client = new Proxy(service, {get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? (...args: unknown[]) => {calls.push(String(key)); return value.apply(target, args);} : value;
    }});
    const editor = document.getElementById('editor')!;
    const view = new KanbanWorkbench({service: client, editor, initialResource: '/board/board/task-0', selected() {},
        openSession: async id => {opened = id;}, presentation: {text: key => (zhCN as Record<string, string>)['kanban.' + key] ?? key,
            icons: {more: '...', close: 'x', refreshView: 'r'}}});
    const measure = async (operation: string, action: () => unknown, ready: () => boolean) => {
        calls = []; const started = performance.now(); await action();
        try {await wait(ready);} catch {throw Error('LEARNING_UI_NOT_READY:' + operation);}
        const row = {operation, durationMs: performance.now() - started, logicalApiCalls: calls.length, httpRequests: 0, methods: [...calls]};
        metrics.push(row); if (row.durationMs >= 5000 || row.logicalApiCalls >= 30) throw Error('PERFORMANCE_LIMIT:' + operation);
    };
    await measure('cold.task-detail', () => view.start(), () => !!editor.querySelector('[data-item-history]'));
    await measure('warm.open-history', () => editor.querySelector<HTMLElement>('[data-item-history] > summary')!.click(),
        () => !!editor.querySelector('[data-related-records] [data-record]'));
    await measure('warm.open-learning', () => editor.querySelector<HTMLButtonElement>('[data-related-records] [data-record]')!.click(),
        () => !!editor.querySelector('[data-session="source-session"]') && !!editor.textContent?.includes('Stable operation identity'));
    if (!editor.textContent?.includes('Avoid duplicate side effects')) throw Error('LEARNING_REASON_MISSING');
    await measure('warm.trace-session', () => editor.querySelector<HTMLButtonElement>('[data-session="source-session"]')!.click(), () => opened === 'source-session');
    document.getElementById('result')!.textContent = JSON.stringify({result: 'passed', mode: location.hash === '#baseline' ? 'existing-record' : 'automatic-learning', environment: 'Chrome headless; real Kanban store and DOM; local transport',
        dataset: {boards: 1, tasks: 20, learnings: 1, backgroundLoad: 'none'}, metrics});
    // Preserve an inert final frame for the screenshot after controllers are disposed.
    const frame = editor.cloneNode(true);
    await view.dispose(); editor.append(...Array.from(frame.childNodes)); editor.inert = true;
}
void run().catch(error => {document.getElementById('result')!.textContent = JSON.stringify({result: 'failed', code: error instanceof Error ? error.message : 'UNKNOWN'});});
