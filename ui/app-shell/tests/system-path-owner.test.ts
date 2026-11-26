import {expect, it, vi} from 'vitest';
import {ViewLoad} from '../src/lifecycle/view-load';
import {openProjectFileEditor} from '../src/projects/project-file-editor';
import type {ProjectService} from '@nestos/app-contracts/services';

it('releases a prepared path workspace when opening is cancelled before reading', async () => {
    const controller = new AbortController(); controller.abort();
    const dispose = vi.fn(async () => {}), openWorkspace = vi.fn();
    let cleanup: Promise<void> | undefined;
    const prepared = {fs:{}, initialFile:{node:null,readonly:true}, dispose};
    const options = {prepared, deferCleanup:(value:Promise<void>) => {cleanup=value;}} as unknown as Parameters<typeof openProjectFileEditor>[3];
    await expect(openProjectFileEditor({openWorkspace} as unknown as ProjectService,
        {folder:'/fixture',path:'/workspace/file.rs'},new ViewLoad(controller.signal),options)).rejects.toThrow();
    await cleanup;
    expect(dispose).toHaveBeenCalledOnce(); expect(openWorkspace).not.toHaveBeenCalled();
});
