// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest';
import {linkSystemPaths} from '@nestos/llm-ui';
import type {ApplicationBackend} from '@nestos/app-contracts/services';
import {resolveSystemPath, systemLineOffset} from '../src/projects/system-path';

describe('path link integration', () => {
    it('connects command text to the authorized project and line 26', async () => {
        const projects = {openSystemPath:async () => ({project:{path:'/cx1'},path:'tools/cells/src/http/agent_mcp.rs',workspace:{}})} as unknown as ApplicationBackend;
        let completed = false;
        const open = vi.fn(async (raw: string) => {
            const target = await resolveSystemPath(projects, 'cx1', raw);
            const text = Array.from({length:30}, (_, i) => `line ${i + 1}`).join('\n');
            expect(target).toMatchObject({project:{path:'/cx1'},path:'tools/cells/src/http/agent_mcp.rs',line:26});
            expect(text.slice(systemLineOffset(text, target.line!))).toMatch(/^line 26/); completed = true;
        });
        const output = document.createElement('pre'); output.textContent = '/home/li/share/prj/x1/tools/cells/src/http/agent_mcp.rs:26';
        linkSystemPaths(output, open); output.querySelector('a')!.click();
        await vi.waitFor(() => expect(completed).toBe(true));
        expect(open).toHaveBeenCalledOnce();
    });
});
