import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {kanbanConfigurationResources} from '../src/presets/kanban-configuration-resources';
import {kanbanConfigurationDefaults} from '../src/resources/catalog';
import {ensureKanbanConfiguration} from '../src/presets/kanban-global-configuration';
import {readPrompt} from '../src/run/prompt-bundle';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());return manager.openFileSystem('/');}
it('restores the complete installed bundle and manifest while preserving project overrides',async()=>{
    const fs=await fixture(),api=kanbanConfigurationResources(fs),id='kanban:global-configuration',root='/etc/kanban/development';
    expect((await api.list())[0]).toMatchObject({id,exists:false,overwrite:true,group:'kanban'});
    await api.restore(id);expect((await api.list())[0].exists).toBe(true);
    const manifest=JSON.parse(await readPrompt(fs,root+'/profile.json'));
    expect(manifest.files).toEqual(Object.keys(kanbanConfigurationDefaults));
    for(const [name,content] of Object.entries(kanbanConfigurationDefaults))expect(await readPrompt(fs,root+'/'+name)).toBe(content);
    await fs.driver.writeContent(root+'/planning.md','Custom planning');
    await fs.driver.writeContent(root+'/bootstrap.md','Custom bootstrap');
    await fs.driver.writeContent('/etc/kanban/.defaults.json','Broken marker');
    const project='/workspace/_nestos/etc/kanban/development';
    await fs.driver.createFile({parentPath:project,name:'task.md',content:'Project override',recursive:true});
    await api.restore(id);await ensureKanbanConfiguration(fs);
    expect(await readPrompt(fs,root+'/planning.md')).toBe(kanbanConfigurationDefaults['planning.md']);
    expect(await readPrompt(fs,root+'/bootstrap.md')).toBe(kanbanConfigurationDefaults['bootstrap.md']);
    expect(await readPrompt(fs,project+'/task.md')).toBe('Project override');
});
it('forwards unrelated recovery resources and surfaces partial-write failures without reporting success',async()=>{
    const fs=await fixture(),other={list:async()=>[{id:'other',group:'kanban' as const,name:'Other',path:'/other',exists:false}],restore:vi.fn(async()=>true)};
    const api=kanbanConfigurationResources(fs,other);
    expect((await api.list()).map(row=>row.id)).toEqual(['other','kanban:global-configuration']);
    expect(await api.restore('other')).toBe(true);expect(other.restore).toHaveBeenCalledWith('other');
    await api.restore('kanban:global-configuration');
    vi.spyOn(fs.driver,'writeContent').mockRejectedValueOnce(Object.assign(Error('Read-only'),{code:'EACCES'}));
    await expect(api.restore('kanban:global-configuration')).rejects.toMatchObject({code:'EACCES'});
});

it('recovers an interrupted same-version restore on the next startup',async()=>{
    const fs=await fixture(),api=kanbanConfigurationResources(fs),id='kanban:global-configuration';
    await api.restore(id);await fs.driver.writeContent('/etc/kanban/development/task.md','User tuning');
    const original=fs.driver.writeContent.bind(fs.driver);
    const spy=vi.spyOn(fs.driver,'writeContent').mockImplementation(async(...args)=>{
        if(args[0]==='/etc/kanban/development/planning.md')throw Object.assign(Error('Interrupted write'),{code:'EIO'});
        return original(...args);
    });
    await expect(api.restore(id)).rejects.toMatchObject({code:'EIO'});spy.mockRestore();
    expect(JSON.parse(await readPrompt(fs,'/etc/kanban/.defaults.json')).version).toBe('pending');
    await ensureKanbanConfiguration(fs);
    expect(await readPrompt(fs,'/etc/kanban/development/task.md')).toBe(kanbanConfigurationDefaults['task.md']);
    expect(JSON.parse(await readPrompt(fs,'/etc/kanban/.defaults.json')).version).not.toBe('pending');
});
