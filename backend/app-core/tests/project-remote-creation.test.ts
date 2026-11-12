import {afterEach, expect, it, vi} from 'vitest';
import {FSError, MemoryBackend} from '@nestos/vfs-core';
import {createApplicationRuntime, type ApplicationRuntime} from '../src/runtime/create-application-runtime';
import {ProjectRepository} from '../src/projects/project-repository';

let runtime: ApplicationRuntime | undefined;
afterEach(async () => {await runtime?.dispose();runtime=undefined;});
async function fixture() {
    runtime=await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web'});
    const fs=await runtime.vfs.openFileSystem('/');
    const node={id:'node',name:'Node',endpoint:'https://files.test',projects:true};
    const grants=new Map<string, any[]>();
    const remote={connection:()=>node,connections:()=>[node],findRemoteProject:vi.fn(():string|undefined=>undefined),
        list:(id:string)=>grants.get(id)??[],forgetProject:vi.fn(async(id:string)=>{grants.delete(id);}),
        bindProject:vi.fn(async(id:string)=>{grants.set(id,[{connectionId:'node',mountId:'grant',alias:'docs',root:'/work',at:'/',access:'rw'}]);})};
    runtime.projects.remoteMounts=remote as never;
    return {runtime,fs,remote,grants};
}
it('writes no project identity or ID when binding fails and retries the same explicit ID', async () => {
    const f=await fixture();f.remote.bindProject.mockRejectedValue(new FSError('EBUSY','busy'));
    for(let attempt=0;attempt<2;attempt++) {
        await expect(f.runtime.projects.createRemote('Work',null,'node','/docs/work','rw',{projectId:'work'})).rejects.toMatchObject({code:'EBUSY'});
        expect(await f.fs.meta.seq!.getEntry('/etc/project-identities.seq','work')).toBeNull();
        expect((await f.runtime.projects.list()).some(p=>p.project.id==='work')).toBe(false);
        expect((await f.runtime.sessionRepository.listFolders()).some(p=>p.project?.id==='work')).toBe(false);
    }
    expect(f.remote.bindProject).toHaveBeenCalledTimes(2);
});
it('commits identity and ID after successful binding and retains the ID after real deletion', async () => {
    const f=await fixture();const project=await f.runtime.projects.createRemote('Work',null,'node','/docs/work','rw',{projectId:'work'});
    expect(project.project.id).toBe('work');
    expect(await f.fs.meta.seq!.getEntry('/etc/project-identities.seq','work')).toBe('work');
    await f.runtime.projects.removeProjectSource(project);
    await expect(f.runtime.projects.createRemote('Other',null,'node','/docs/other','rw',{projectId:'work'})).rejects.toMatchObject({code:'EEXIST'});
});
it('computes candidates without reserving and atomically rejects a competing final commit', async () => {
    const f=await fixture(),repo=new ProjectRepository(f.fs,f.runtime.directoryMounts);
    try {
        expect(await repo.candidateId('Work','work')).toBe('work');expect(await repo.candidateId('Work','work')).toBe('work');
        const commits=await Promise.allSettled([
            repo.commitRemoteCreation({version:1,id:'work',name:'First',createdAt:1}),
            repo.commitRemoteCreation({version:1,id:'work',name:'Second',createdAt:2}),
        ]);
        expect(commits.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        expect(commits.filter(result=>result.status==='rejected')).toHaveLength(1);
        expect((await repo.list()).filter(project=>project.id==='work')).toHaveLength(1);
    } finally {repo.dispose();}
});
it('clears the unpublished binding if the final identity commit fails without deleting source data', async () => {
    const f=await fixture(),set=f.fs.meta.seq!.setEntry;
    f.remote.bindProject.mockImplementation(async(id:string)=>{
        f.grants.set(id,[{connectionId:'node',mountId:'grant',alias:'docs',root:'/work',at:'/',access:'rw'}]);
        await set.call(f.fs.meta.seq,'/etc/project-identities.seq',id,id);
    });
    await expect(f.runtime.projects.createRemote('Work',null,'node','/docs/work','rw',{projectId:'work'})).rejects.toMatchObject({code:'EEXIST'});
    expect(f.remote.forgetProject).toHaveBeenCalledWith('work');expect(f.grants.size).toBe(0);
    expect(await f.fs.meta.seq!.getEntry('/etc/project-identities.seq','work')).toBe('work');
});

it('recovers navigation after the final commit without registering or allocating the ID again', async () => {
    const f=await fixture(),original=f.runtime.sessionRepository.createFolder.bind(f.runtime.sessionRepository);
    const navigation=vi.spyOn(f.runtime.sessionRepository,'createFolder').mockImplementation(async(path,project)=>{
        if(path==='/Work')throw new Error('navigation unavailable');return original(path,project);
    });
    await expect(f.runtime.projects.createRemote('Work',null,'node','/docs/work','rw',{projectId:'work'})).rejects.toThrow('navigation unavailable');
    expect(await f.fs.meta.seq!.getEntry('/etc/project-identities.seq','work')).toBe('work');
    expect(f.grants.has('work')).toBe(true);expect(f.remote.forgetProject).not.toHaveBeenCalled();
    navigation.mockRestore();f.remote.findRemoteProject.mockReturnValue('work');
    expect((await f.runtime.projects.createRemote('Work',null,'node','/docs/work','rw',{projectId:'work'})).project.id).toBe('work');
    expect(f.remote.bindProject).toHaveBeenCalledTimes(1);
    expect((await f.runtime.sessionRepository.listFolders()).filter(folder=>folder.project?.id==='work')).toHaveLength(1);
});

it('validates an unpublished candidate without writing an identity for validation', async () => {
    const f=await fixture();
    f.remote.bindProject.mockImplementation(async(id:string)=>{
        await expect(f.runtime.projects.get(id)).rejects.toMatchObject({code:'ENOENT'});
        const mount={connectionId:'node',mountId:'grant',alias:'docs',root:'/work',at:'/',access:'rw'};
        await (f.remote as any).rootValidator(id,mount);
        f.grants.set(id,[mount]);
    });
    expect((await f.runtime.projects.createRemote('Work',null,'node','/docs/work','rw',{projectId:'work'})).project.id).toBe('work');
});
