import {afterEach,it,expect} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {readPrompt} from '../src/run/prompt-bundle';
import {ensureKanbanConfiguration} from '../src/presets/kanban-global-configuration';
import {resolveKanbanConfiguration} from '../src/presets/kanban-configuration-files';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());return manager.openFileSystem('/');}
it('preserves edits on normal restart and replaces global configuration when the shipped version changes',async()=>{
    const fs=await fixture(),path='/etc/kanban/development/planning.md';
    await ensureKanbanConfiguration(fs);const original=await readPrompt(fs,path);
    await fs.driver.writeContent(path,'Tuned prompt');await ensureKanbanConfiguration(fs);
    expect(await readPrompt(fs,path)).toBe('Tuned prompt');
    await fs.driver.writeContent('/etc/kanban/.defaults.json',JSON.stringify({schema:1,version:'previous'}));
    await ensureKanbanConfiguration(fs);expect(await readPrompt(fs,path)).toBe(original);
    await ensureKanbanConfiguration(fs,true);
});
it('ships only declared data files and conventional lifecycle hooks, honoring project overrides',async()=>{
    const fs=await fixture();await ensureKanbanConfiguration(fs);
    const path='/etc/kanban/development/profile.json',manifest=JSON.parse(await readPrompt(fs,path));
    manifest.files.push('report.yaml');await fs.driver.writeContent(path,JSON.stringify(manifest));
    await fs.driver.createFile({parentPath:'/etc/kanban/development',name:'report.yaml',content:'schema: report/1',recursive:true});
    await fs.driver.createFile({parentPath:'/etc/kanban/development',name:'unlisted.txt',content:'Do not transfer',recursive:true});
    await fs.driver.createFile({parentPath:'/workspace/_nestos/etc/kanban/development',name:'report.yaml',content:'schema: project-report/1',recursive:true});
    const files=await resolveKanbanConfiguration(fs,fs,'development');
    expect(files.find(file=>file.name==='report.yaml')).toMatchObject({content:'schema: project-report/1'});
    expect(files.some(file=>file.name==='unlisted.txt')).toBe(false);
    manifest.files.push('../secret.txt');await fs.driver.writeContent(path,JSON.stringify(manifest));
    await expect(resolveKanbanConfiguration(fs,fs,'development')).rejects.toMatchObject({code:'KANBAN_PROFILE_INVALID'});
});
it('reports missing or malformed configurations instead of silently replacing their intent with defaults',async()=>{
    const fs=await fixture();await expect(ensureKanbanConfiguration(fs,true)).rejects.toMatchObject({code:'KANBAN_CONFIGURATION_UPGRADE_REQUIRED'});
    await ensureKanbanConfiguration(fs);
    await fs.driver.delete(['/etc/kanban/development/planning.md']);
    await expect(resolveKanbanConfiguration(fs,fs,'development')).rejects.toMatchObject({code:'KANBAN_PROFILE_FILE_MISSING'});
    await fs.driver.writeContent('/etc/kanban/development/profile.json','not json');
    await expect(resolveKanbanConfiguration(fs,fs,'development')).rejects.toMatchObject({code:'KANBAN_PROFILE_INVALID'});
});
