import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {SessionCommand} from '@nestos/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {bindApplicationBackend} from '../src/host/application-client';

it('enforces scope on direct backend Send and persists project defaults before publishing a new Agent', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    const backend = bindApplicationBackend(runtime);
    try {
        const a = await runtime.projects.create('Scope A'), b = await runtime.projects.create('Scope B');
        const toolbox = await backend.toolboxView(), original = runtime.agentService.saveAgent.bind(runtime.agentService);
        const save = vi.spyOn(runtime.agentService, 'saveAgent').mockImplementationOnce(async definition => {
            expect((await backend.readAgentProjectScopes([definition.id]))[definition.id]).toEqual({kind: 'selected', projectIds: [a.project.id]});
            await original(definition);
        });
        await toolbox.resources.create('agents', 'Project Agent', undefined, undefined, a.project.id);
        expect(save).toHaveBeenCalledOnce(); const id = save.mock.calls[0][0].id; save.mockRestore();
        const folder = await runtime.projects.sessionFolder(b), session = await runtime.sessionRepository.createSession('Readable history', folder);
        await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: session});
        await expect(runtime.commandBus.execute(SessionCommand.Send, {agentId: id, text: 'PRIVATE-MESSAGE', files: []}))
            .rejects.toMatchObject({code: 'AGENT_PROJECT_SCOPE_DENIED'});
        expect((await runtime.sessionRepository.getManifest(session)).title).toBe('Readable history');
        await toolbox.dispose();
    } finally {await runtime.dispose();}
});
