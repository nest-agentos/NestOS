import {expect, it, vi} from 'vitest';
import {decisionSourceContext} from '../src/kanban/decision-source-session';
import type {DecisionConversationOptions} from '../src/kanban/decision-conversation-ports';

const source = {projectId:'project', profileId:'codex', sessionId:'original'};

it('reads the original Session through a read-only port and freezes a bounded excerpt for retry', async () => {
    let saved: unknown;
    const read = vi.fn(async () => ({
        sessionId:source.sessionId, title:'Original', disconnected:false,
        messages:[...Array.from({length:10}, (_, index) => ({role:'user',text:'message'+index})),
            {role:'tool',text:'private-tool-output'}, {role:'assistant',text:'a'.repeat(1600)}],
    }));
    const close = vi.fn(), projectConversation = vi.fn(async () => ({read,close})), log = vi.fn();
    const options = {
        remote:{projectConversation}, log,
        journal:{get:async () => saved, update:async (_key: string, change: (value: unknown) => unknown) => saved = change(saved)},
    } as unknown as DecisionConversationOptions;
    const frozen = await decisionSourceContext(options,'board','operation','project',source);
    expect(frozen?.excerpts).toHaveLength(8);
    expect(frozen?.excerpts[0].text).toBe('message3');
    expect(frozen?.excerpts.at(-1)?.text).toHaveLength(1200);
    expect(projectConversation).toHaveBeenCalledWith('project','codex','original',undefined,true);
    expect(close).toHaveBeenCalledOnce();
    expect(await decisionSourceContext(options,'board','operation','project',source)).toBe(frozen);
    await expect(decisionSourceContext(options,'board','other','unrelated',source)).rejects.toMatchObject({code:'DECISION_SOURCE_PROJECT_MISMATCH'});
    expect(projectConversation).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/message3|private-tool-output/);
});
