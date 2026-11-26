import {describe, expect, it, vi} from 'vitest';
import {ProjectService} from '../src/projects/project-service';
import {chooseSystemPath} from '../src/projects/system-path-opening';
import type {ProjectFolder, ProjectRemoteMountService} from '@nestos/app-contracts/services';

const folders = [{project:{id:'a'},path:'/a'},{project:{id:'b'},path:'/b'}] as ProjectFolder[];
function fixture() {
    const resolvePath = vi.fn(async (id: string) => ({path:'src/file.rs',specificity:id === 'a' ? 5 : 9,kind:'physical' as const,project:{id:`cells-${id}`,revision:3}}));
    const remote = {list:() => [{at:'/',connectionId:'node'}],resolvePath} as unknown as ProjectRemoteMountService;
    return {remote,resolvePath};
}
describe('system path opening', () => {
    it('chooses the most specific binding and rejects ties', async () => {
        const {remote,resolvePath} = fixture();
        const selected = await chooseSystemPath(folders,remote,'a','/host/file','operation');
        expect(selected).toMatchObject({project:{path:'/b',project:{id:'b'}},path:'src/file.rs'});
        expect(selected.project).toBe(folders[1]);
        resolvePath.mockImplementation(async () => ({path:'src/file.rs',specificity:9,kind:'physical',project:{id:'cells-other',revision:3}}));
        await expect(chooseSystemPath(folders,remote,'a','/host/file','operation')).rejects.toMatchObject({remoteCode:'PATH_AMBIGUOUS'});
    });
    it('fails closed on inaccessible bindings and keeps workspace paths in the current project', async () => {
        const {remote,resolvePath} = fixture();
        await chooseSystemPath(folders,remote,'a','/workspace/file','operation');
        expect(resolvePath).toHaveBeenCalledTimes(1);
        resolvePath.mockRejectedValueOnce(Object.assign(new Error('denied'),{remoteCode:'EACCES'}));
        await expect(chooseSystemPath(folders,remote,'a','/host/file','operation')).rejects.toMatchObject({remoteCode:'EACCES'});
    });
});

it('shares one catalog and disposes the prepared workspace if authorization changes', async () => {
    const project = folders[0], list = vi.fn(async () => [project]);
    let version = 1;
    const remote = {list:() => [{at:'/',connectionId:'node',version}], resolvePath:async () => ({path:'file.rs',specificity:8,kind:'workspace'})};
    const dispose = vi.fn(async () => {}), workspace = {fs:{},initialFile:{node:null,readonly:true},dispose};
    const service = Object.create(ProjectService.prototype) as ProjectService;
    Object.assign(service,{list,remote,openWorkspaceFor:vi.fn(async () => {version++; return workspace;})});
    await expect(service.openSystemPath(project.project.id,'/workspace/file.rs','operation')).rejects.toMatchObject({code:'ECONFLICT'});
    expect(list).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledOnce();
});
