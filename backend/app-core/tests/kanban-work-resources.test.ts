import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {developmentWorkResources} from '../src/presets/kanban-work-resources';
import {inspectWorktree, worktreeBlockers} from '../src/projects/worktree-status';

const native = vi.hoisted(() => ({reasons: [] as string[]}));
vi.mock('../src/presets/kanban-work-resource-execution', () => ({workResourceExecution: vi.fn(async () => native.reasons)}));
const exec = promisify(execFile), closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); native.reasons = [];});
async function fixture(withModule=false) {
    const root = await mkdtemp(join(tmpdir(), 'nestos-resource-')); closes.push(() => rm(root, {recursive: true, force: true}));
    const git = async (cwd: string, args: string[]) => exec('git', args, {cwd});
    await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fixture']); await git(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(root, '.gitignore'), '/_nestos/\n/cache/\n'); await writeFile(join(root, 'file.txt'), 'Original');
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'test: base']);
    if(withModule){const module=await mkdtemp(join(tmpdir(),'nestos-module-'));closes.push(()=>rm(module,{recursive:true,force:true}));
        await git(module,['init','-b','main']);await git(module,['config','user.name','Fixture']);await git(module,['config','user.email','fixture@example.invalid']);
        await writeFile(join(module,'file.txt'),'Module');await writeFile(join(module,'.gitignore'),'cache/\n');await git(module,['add','.']);await git(module,['commit','-m','test: module']);
        await git(root,['-c','protocol.file.allow=always','submodule','add',module,'library']);await git(root,['commit','-am','test: register module']);}
    const directory = '/workspace/_nestos/worktrees/ready', physical = join(root, '_nestos/worktrees/ready');
    await git(root, ['worktree', 'add', '-b', 'work/ready', physical]);
    if(withModule)await git(physical,['-c','protocol.file.allow=always','submodule','update','--init']);
    const tree = {id: 'ready', directory, branch: 'work/ready', baseCommit: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), phase: 'ready' as const};
    const commands: string[][] = [];
    const process = {release: vi.fn(async () => {}), nativeShell: {exec: async (_name: string, args: string[], options: {cwd: string}) => {
        commands.push(args); const actual = args.map(value => value.replaceAll('/workspace', root));
        try {const r = await git(options.cwd.replace('/workspace', root), actual); return {code: 0, stdout: r.stdout.replaceAll(root, '/workspace'), stderr: r.stderr};}
        catch (error) {const r = error as {code: number; stdout: string; stderr: string}; return {code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};}
    }}} as never;
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: directory + '/_nestos/kanban/inbox', name: 'result.yaml', content: 'Retained evidence', recursive: true});
    const journal = new KanbanAutomationJournal(fs, kanbanJournalOptions); await journal.open();
    await journal.update('worktree:ready', () => tree);
    await journal.update('development-workspace:ready', () => ({directory, projectId: 'project',availableRepositories:withModule?[{path:'library'}]:[], context: {board: {id: 'board'}, task: {id: 'item'}}}));
    const item = {id: 'item', status: 'completed', revision: 1, externalRefs: [{system: 'nestos-remote-project', id: 'project'}, {system: 'nestos-worktree', id: 'ready'}]};
    const service = {catalog:async()=>[],query:async()=>({items:[],total:0}),item: async () => ({item}), read: async () => ({members: [{kind: 'human', id: 'admin', roles: ['coordinator']}]}),
        currentPrincipal: async () => ({kind: 'human', id: 'admin'}), workflow: async () => ({dispatches: {}})} as never;
    const workLog = {records: vi.fn(async () => ({items: []})), append: vi.fn(async () => {})};
    const mount = {at: '/', access: 'rw', connectionId: 'connection', serverProjectId: 'server-project', serverProjectRevision: 1, serverId: 'server'};
    const options = {fs, service, workLog, journal, calls: {}, kernel: {},
        projects: {get: async () => ({path: '/project', name: 'Project'}), openWorkspace: async () => ({fs, dispose: async () => {}})},
        remote: {list: () => [mount], resolveConnection: async () => ({})}, provider: {
            projects: () => ({read: async () => ({revision: 1, mounts: []}), close: async () => {}}),
            capabilities: async () => ({serverId: 'server', processEpoch: 'epoch'}), projectProcess: async () => process}} as never;
    return {root, physical, fs, tree, process, git, item, service, workLog, journal, commands, api: developmentWorkResources(options)};
}
it('checks real Git ancestry, uncommitted changes and ignored files before offering cleanup', async () => {
    const f = await fixture(); expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toEqual([]);
    await writeFile(join(f.physical, 'file.txt'), 'Uncommitted');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toContain('WORKTREE_DIRTY');
    await f.git(f.physical, ['add', 'file.txt']); await f.git(f.physical, ['commit', '-m', 'test: unintegrated']);
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toContain('WORKTREE_NOT_INTEGRATED');
    await mkdir(join(f.physical, 'cache')); await writeFile(join(f.physical, 'cache/private'), 'Keep');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toContain('WORKTREE_UNTRACKED_IGNORED');
});
it('lists saved associations without remote Git or native-session inspection and refuses unchecked cleanup', async () => {
    const f = await fixture(); f.commands.splice(0);
    const rows = await f.api.workResources('board','item',{inspect:false});
    expect(rows[0]).toMatchObject({id:'ready',title:'work/ready',location:f.tree.directory,state:'associated',canCleanup:false,version:''});
    expect(f.commands).toEqual([]); expect(native.reasons).toEqual([]);
    await expect(f.api.cleanupWorkResource('board',{operationId:'unchecked',itemId:'item',resourceId:'ready',version:''})).rejects.toMatchObject({code:'INVALID_WORK_RESOURCE_CLEANUP'});
    await expect(f.api.workResources('board','item',{inspect:'yes'} as never)).rejects.toMatchObject({code:'INVALID_WORK_RESOURCE_QUERY'});
});
it('excludes only archived protocol evidence without enumerating ignored dependency files', async () => {
    const f = await fixture();
    await mkdir(join(f.physical, '_nestos/kanban/inbox'), {recursive: true});
    await writeFile(join(f.physical, '_nestos/kanban/inbox/result.yaml'), 'Evidence');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree, '_nestos/kanban/'))).toEqual([]);
    await writeFile(join(f.physical, '_nestos/private'), 'Keep');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree, '_nestos/kanban/'))).toContain('WORKTREE_UNTRACKED_IGNORED');
    expect(f.commands.some(args => args[0] === 'ls-files' && args.includes('--directory'))).toBe(true);
});
it('archives evidence before safe removal, deletes only the merged branch and returns the original receipt on retry', async () => {
    const f = await fixture(), preview = (await f.api.workResources('board', 'item'))[0];
    expect(preview).toMatchObject({id: 'ready', state: 'cleanup-ready', canCleanup: true});
    const request = {operationId: 'cleanup-one', itemId: 'item', resourceId: 'ready', version: preview.version};
    expect(await f.api.cleanupWorkResource('board', request)).toMatchObject({state: 'cleaned', canCleanup: false});
    expect(new TextDecoder().decode(await f.fs.driver.readContent('/var/lib/kanban/worktree-archives/ready/inbox/result.yaml', {encoding: 'binary'}))).toBe('Retained evidence');
    await expect(stat(f.physical)).rejects.toMatchObject({code: 'ENOENT'});
    expect(f.commands.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toEqual([['worktree', 'remove', f.tree.directory]]);
    await f.api.cleanupWorkResource('board', request);
    expect(f.commands.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(1);
    expect(f.commands.flat()).not.toContain('--force'); expect(f.commands.flat()).not.toContain('-D');
    expect(f.workLog.append).toHaveBeenCalledWith(expect.anything(), 'board', 'item', expect.objectContaining({stage: 'worktree.cleaned'}));
});
it('refuses unfinished tasks, changed previews and sessions that become busy before cleanup', async () => {
    const f = await fixture(), resource = (await f.api.workResources('board', 'item'))[0];
    const request = {operationId: 'cleanup-one', itemId: 'item', resourceId: 'ready', version: resource.version};
    f.item.revision++;
    await expect(f.api.cleanupWorkResource('board', request)).rejects.toMatchObject({code: 'WORKTREE_STATE_CHANGED'});
    f.item.revision--; f.item.status = 'claimed';
    await expect(f.api.cleanupWorkResource('board', request)).rejects.toMatchObject({code: 'WORKTREE_TASK_UNFINISHED'});
    f.item.status = 'completed'; native.reasons = ['WORKTREE_IN_USE'];
    await expect(f.api.cleanupWorkResource('board', request)).rejects.toMatchObject({code: 'WORKTREE_IN_USE'});
    expect(f.commands.some(args => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect((await stat(f.physical)).isDirectory()).toBe(true);
});
it('keeps the directory intact when evidence cannot be archived', async () => {
    const f = await fixture(), resource = (await f.api.workResources('board', 'item'))[0];
    const create = f.fs.driver.createFile.bind(f.fs.driver);
    vi.spyOn(f.fs.driver, 'createFile').mockImplementation(async options => {
        if (options.parentPath?.startsWith('/var/lib/kanban/worktree-archives/')) throw Object.assign(new Error('disk unavailable'), {code: 'EIO'});
        return create(options);
    });
    await expect(f.api.cleanupWorkResource('board', {operationId: 'archive-failure', itemId: 'item', resourceId: 'ready', version: resource.version})).rejects.toMatchObject({code: 'EIO'});
    expect((await stat(f.physical)).isDirectory()).toBe(true);
    expect(f.commands.some(args => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect((await f.api.workResources('board', 'item'))[0]).toMatchObject({state: 'cleanup-ready', canCleanup: true});
});
it('allows only one cleanup owner under concurrent requests', async () => {
    const f = await fixture(), resource = (await f.api.workResources('board', 'item'))[0];
    const request = {operationId: 'same-cleanup', itemId: 'item', resourceId: 'ready', version: resource.version};
    const result = await Promise.allSettled([f.api.cleanupWorkResource('board', request), f.api.cleanupWorkResource('board', request)]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(f.commands.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(1);
});
it('recovers a historical resource association from its original dispatch without inventing task ownership', async () => {
    const f = await fixture(); f.item.externalRefs = f.item.externalRefs.filter(row => row.system !== 'nestos-worktree');
    (f.service as any).workflow = async () => ({dispatches: {ready: {id: 'ready', itemId: 'item', outcome: 'accepted'}, other: {id: 'foreign', itemId: 'elsewhere', outcome: 'accepted'}}});
    expect(await f.api.workResources('board', 'item')).toEqual([expect.objectContaining({id: 'ready', state: 'cleanup-ready'})]);
});
it('serializes checks on the same node and never replays an unknown process admission', async () => {
    const f = await fixture(), shell = (f.process as any).nativeShell, original = shell.exec; let active = 0;
    shell.exec = vi.fn(async (...args: unknown[]) => {
        expect(active).toBe(0); active++;
        try {await new Promise(resolve => setTimeout(resolve, 2)); return await original(...args);}
        finally {active--;}
    });
    await Promise.all([f.api.workResources('board', 'item'), f.api.workResources('board', 'item')]);
    shell.exec = vi.fn(async () => {throw Object.assign(new Error('unknown'), {code: 'EIO', remoteCode: 'EBUSY', outcome: 'unknown'});});
    expect((await f.api.workResources('board', 'item'))[0]).toMatchObject({state: 'unknown', canCleanup: false});
    expect(shell.exec).toHaveBeenCalledOnce();
});
it('retries only a busy admission that the node confirms did not start', async () => {
    const f = await fixture(), shell = (f.process as any).nativeShell, original = shell.exec;
    shell.exec = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), {code: 'EIO', remoteCode: 'EBUSY', outcome: 'not-committed'})).mockImplementation(original);
    expect((await f.api.workResources('board', 'item'))[0]).toMatchObject({state: 'cleanup-ready'});
});

it('retains a resource owned by another board before contacting Git and refuses cleanup', async () => {
    const f=await fixture();
    const journal=new KanbanAutomationJournal(f.fs, kanbanJournalOptions);await journal.open();
    await journal.update('development-workspace:ready',()=>({directory:f.tree.directory,projectId:'project',context:{board:{id:'another-board'},task:{id:'another-task'}}}));
    f.commands.splice(0);
    const rows=await f.api.workResources('board','item');
    expect(rows[0]).toMatchObject({ownership:'other',state:'retained',canCleanup:false,reasons:['WORKTREE_OTHER_OWNER']});
    expect(f.commands).toEqual([]);
    await expect(f.api.cleanupWorkResource('board',{itemId:'item',resourceId:'ready',version:rows[0].version,operationId:'foreign-cleanup'})).rejects.toMatchObject({code:'WORKTREE_OTHER_OWNER'});
    expect(await stat(f.physical)).toBeDefined();expect(f.commands).toEqual([]);
});

it('retains a worktree referenced by another board before inspecting or removing Git state',async()=>{
    const f=await fixture(),service=f.service as unknown as {catalog():Promise<Array<{id:string}>>;query:ReturnType<typeof vi.fn>};
    service.catalog=async()=>[{id:'another-board'}];service.query=vi.fn(async(board:string)=>board==='another-board'?({items:[{id:'other-task'}],total:1}):({items:[],total:0}));
    f.commands.splice(0);
    const [resource]=await f.api.workResources('board','item');
    expect(resource).toMatchObject({state:'retained',canCleanup:false,reasons:['WORKTREE_SHARED']});
    expect(service.query).toHaveBeenCalledWith('another-board',expect.objectContaining({reference:{system:'nestos-worktree',id:'ready'},includeDeleted:true}));
    expect(f.commands).toEqual([]);
    await expect(f.api.cleanupWorkResource('board',{itemId:'item',resourceId:'ready',version:resource.version,operationId:'shared-cleanup'})).rejects.toMatchObject({code:'WORKTREE_SHARED'});
    expect(await stat(f.physical)).toBeDefined();
});
it('archives workspace associations without removing directories or running Git cleanup',async()=>{
    const f=await fixture(),before=f.commands.length;
    await f.api.archiveItemResources('board','item','archive-generation');
    await f.api.archiveItemResources('board','item','archive-generation');
    const rows=await f.api.workResources('board','item',{inspect:false});
    expect(rows[0].archivedAt).toBeTypeOf('number');
    expect((await stat(f.physical)).isDirectory()).toBe(true);
    expect(f.commands).toHaveLength(before);
});

it('exposes the current coordination workspace for group cleanup while retaining older planning history',async()=>{
 const f=await fixture();(f.item as any).planning={execution:'children'};f.item.externalRefs.push({system:'nestos-worktree',id:'old-plan'});
 await f.journal.update('analysis-history:'+JSON.stringify(['board','item']),()=>({keys:['analysis:old','analysis:current'],indexed:true}));
 await f.journal.update('analysis:old',()=>({id:'old-plan'}));await f.journal.update('analysis:current',()=>({id:'ready'}));
 await f.journal.update('analysis-current:'+JSON.stringify(['board','item']),()=>'analysis:current');
 expect((await f.api.workResources('board','item',{inspect:false})).map(row=>row.id)).toEqual(['ready']);
});

it('removes populated modules only after proving clean files and integration into their main repositories',async()=>{
 const f=await fixture(true),resource=(await f.api.workResources('board','item'))[0];expect(resource.canCleanup).toBe(true);
 await f.api.cleanupWorkResource('board',{operationId:'module-clean',itemId:'item',resourceId:'ready',version:resource.version});
 expect(f.commands).toContainEqual(['worktree','remove','--force',f.tree.directory]);await expect(stat(f.physical)).rejects.toMatchObject({code:'ENOENT'});
 expect((await f.git(join(f.root,'library'),['status','--porcelain'])).stdout).toBe('');
});
it('retains ignored files inside populated modules instead of treating a clean parent as disposable',async()=>{
 const f=await fixture(true);await mkdir(join(f.physical,'library/cache'));await writeFile(join(f.physical,'library/cache/private'),'Retain');
 const resource=(await f.api.workResources('board','item'))[0];expect(resource).toMatchObject({canCleanup:false,reasons:expect.arrayContaining(['WORKTREE_UNTRACKED_IGNORED'])});
 expect(f.commands.some(args=>args[0]==='worktree'&&args[1]==='remove')).toBe(false);
});

it('removes explicitly registered merged temporary branches and preserves unrelated branches',async()=>{
 const f=await fixture();await f.git(f.root,['branch','verify/ready/check']);await f.git(f.root,['branch','backup/keep-user-copy']);
 await f.fs.driver.createFile({parentPath:f.tree.directory+'/_nestos/kanban',name:'managed-resources.json',content:JSON.stringify({schema:'nestos.managed-resources/1',scopeId:'ready',branches:[{repository:'.',name:'verify/ready/check'}]}),recursive:true});
 const resource=(await f.api.workResources('board','item'))[0];expect(resource.canCleanup).toBe(true);expect(resource.properties.some(row=>row.value.includes('verify/ready/check'))).toBe(true);
 await f.api.cleanupWorkResource('board',{operationId:'cleanup-registered',itemId:'item',resourceId:'ready',version:resource.version});
 await expect(f.git(f.root,['rev-parse','--verify','refs/heads/verify/ready/check'])).rejects.toBeDefined();expect((await f.git(f.root,['rev-parse','--verify','refs/heads/backup/keep-user-copy'])).stdout.trim()).toHaveLength(40);
});
it('retains branches outside the registered task scope',async()=>{
 const f=await fixture();
 await f.fs.driver.createFile({parentPath:f.tree.directory+'/_nestos/kanban',name:'managed-resources.json',content:JSON.stringify({schema:'nestos.managed-resources/1',scopeId:'ready',branches:[{repository:'.',name:'backup/other/task'}]}),recursive:true});
 expect((await f.api.workResources('board','item'))[0]).toMatchObject({canCleanup:false,reasons:['WORKTREE_BRANCH_SCOPE_INVALID']});
});

it('refuses cleanup while a registered temporary branch contains unintegrated commits',async()=>{
 const f=await fixture();await f.git(f.root,['switch','-c','fix/ready/change']);await writeFile(join(f.root,'fix.txt'),'Unintegrated');await f.git(f.root,['add','fix.txt']);await f.git(f.root,['commit','-m','test: unintegrated fix']);await f.git(f.root,['switch','main']);
 await f.fs.driver.createFile({parentPath:f.tree.directory+'/_nestos/kanban',name:'managed-resources.json',content:JSON.stringify({schema:'nestos.managed-resources/1',scopeId:'ready',branches:[{repository:'.',name:'fix/ready/change'}]}),recursive:true});
 const resource=(await f.api.workResources('board','item'))[0];expect(resource.canCleanup).toBe(false);expect(resource.reasons).toContain('WORKTREE_TEMP_BRANCH_NOT_INTEGRATED');
 expect((await f.git(f.root,['rev-parse','--verify','refs/heads/fix/ready/change'])).stdout.trim()).toHaveLength(40);
});
