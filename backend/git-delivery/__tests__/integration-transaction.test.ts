import {afterEach, expect, it} from 'vitest';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {integrationSourceSnapshotScript} from '../src/integration-source-script';
import {inspectGitIntegration, resumeGitIntegration, tryGitIntegration, validateGitConflictResolutions, type GitIntegrationTransaction} from '../src/integration-transaction';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});
const contents = Array.from({length: 24}, (_, index) => 'line ' + (index + 1)).join('\n') + '\n';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'nestos-integration-'));
    roots.push(root);
    const git = async (...args: string[]) => (await exec('git', args, {cwd: root})).stdout.trim();
    await git('init', '-qb', 'target');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@example.test');
    await git('config', 'status.showUntrackedFiles', 'all');
    await writeFile(join(root, 'shared'), contents);
    await git('add', 'shared');
    await git('commit', '-qm', 'base');
    const previousTarget = await git('rev-parse', 'HEAD');
    const source = join(root, 'source');
    await git('worktree', 'add', '-qb', 'source', source);
    const process = {nativeShell: {async exec(program: string, args: string[], options?: {cwd?: string}) {
        try {return {...await exec(program, args, {cwd: options?.cwd?.replace('/workspace', root)}), code: 0};}
        catch (error) {const result = error as {stdout: string; stderr: string; code: number}; return {...result, code: result.code};}
    }}};
    const input = {operationId: 'test', previousTarget, targetBranch: 'target',
        sources: [{sourceHead: previousTarget, directory: '/workspace/source', repositories: [{path: '.', head: previousTarget, dirty: true}]}]};
    return {root, source, git, process, input};
}

it('applies source changes while preserving separate staged and unstaged edits in the same file', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'shared'), contents.replace('line 1\n', 'source\n'));
    await writeFile(join(f.root, 'shared'), contents.replace('line 12\n', 'staged\n'));
    await f.git('add', 'shared');
    await writeFile(join(f.root, 'shared'), contents.replace('line 12\n', 'staged\n').replace('line 24\n', 'unstaged\n'));
    await writeFile(join(f.root, 'note'), 'untracked\n');
    expect(await tryGitIntegration(f.process, f.input)).toBe('applied');
    expect(await inspectGitIntegration(f.process, f.input)).toBe(await f.git('rev-parse', 'HEAD'));
    expect(await f.git('show', 'HEAD:shared')).toBe(contents.replace('line 1\n', 'source\n').trim());
    expect(await f.git('show', ':shared')).toBe(contents.replace('line 1\n', 'source\n').replace('line 12\n', 'staged\n').trim());
    expect(await readFile(join(f.root, 'shared'), 'utf8')).toBe(contents.replace('line 1\n', 'source\n')
        .replace('line 12\n', 'staged\n').replace('line 24\n', 'unstaged\n'));
    expect(await readFile(join(f.root, 'note'), 'utf8')).toBe('untracked\n');
    expect(await f.git('-C', f.source, 'rev-parse', 'HEAD')).toBe(f.input.previousTarget);
    await writeFile(join(f.source, 'shared'), 'later task work\n');
    expect(await inspectGitIntegration(f.process, f.input)).toBe(await f.git('rev-parse', 'HEAD'));
});

it.each(['staged', 'untracked', 'ignored'])('hands back a %s collision without changing target state', async kind => {
    const f = await fixture();
    const untracked = kind !== 'staged';
    const path = untracked ? 'note' : 'shared';
    if (kind === 'ignored') await writeFile(join(f.root, '.gitignore'), 'note\n');
    await writeFile(join(f.source, path), untracked ? 'source\n' : contents.replace('line 1\n', 'source\n'));
    const target = untracked ? 'user\n' : contents.replace('line 1\n', 'user\n');
    await writeFile(join(f.root, path), target);
    if (!untracked) await f.git('add', path);
    const index = await f.git('write-tree');
    expect(await tryGitIntegration(f.process, f.input)).toBe('session');
    expect(await inspectGitIntegration(f.process, f.input)).toBeUndefined();
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.input.previousTarget);
    expect(await f.git('write-tree')).toBe(index);
    expect(await readFile(join(f.root, path), 'utf8')).toBe(target);
});

it('requires a fresh approval when the frozen plan omitted a real Git conflict',async()=>{
    const f=await fixture();
    await writeFile(join(f.root,'shared'),contents.replace('line 1\n','target edit\n'));
    await f.git('add','shared');await f.git('commit','-qm','target edit');
    await writeFile(join(f.source,'shared'),contents.replace('line 1\n','source edit\n'));
    const previousTarget=await f.git('rev-parse','HEAD'),input={...f.input,previousTarget};
    await expect(tryGitIntegration(f.process,input)).rejects.toMatchObject({code:'MERGE_PLAN_CONFLICTS_MISSING',executionOutcome:'not-started'});
    expect(await f.git('rev-parse','HEAD')).toBe(previousTarget);
    expect(await inspectGitIntegration(f.process,input)).toBeUndefined();
});

it('keeps the named target file and replays its unpublished edit when an older source overlaps it',async()=>{
    const f=await fixture();
    const original=contents+'local assertion\n';
    await writeFile(join(f.root,'shared'),original);
    await writeFile(join(f.source,'shared'),contents+'obsolete assertion\n');
    await writeFile(join(f.source,'delivered'),'current implementation\n');
    const path='shared',choice='retain-target';
    const approve=(path:string)=>({selections:{overlap:choice},plan:{conflicts:[{id:'overlap',path,options:[{id:choice}]}]}});
    await expect(tryGitIntegration(f.process,{...f.input,approval:approve('missing')}))
        .rejects.toMatchObject({code:'INTEGRATION_RETAIN_TARGET_INVALID',executionOutcome:'not-started'});
    const input={...f.input,approval:approve(path)};
    expect(await tryGitIntegration(f.process,input)).toBe('applied');
    const target=await f.git('rev-parse','HEAD');
    expect(await inspectGitIntegration(f.process,input)).toBe(target);
    expect(await f.git('show','HEAD:shared')).toBe(contents.trim());
    expect(await readFile(join(f.root,'shared'),'utf8')).toBe(original);
    expect(await f.git('show','HEAD:delivered')).toBe('current implementation');
    expect(await readFile(join(f.source,'shared'),'utf8')).toBe(contents+'obsolete assertion\n');
});

it('verifies two changes-only sources against their respective integration steps', async () => {
    const f = await fixture();
    const second = join(f.root, 'second');
    await f.git('worktree', 'add', '-qb', 'second', second);
    const first = contents.replace('line 1\n', 'source one\n');
    await writeFile(join(f.source, 'shared'), first);
    await writeFile(join(second, 'shared'), contents.replace('line 24\n', 'source two\n'));
    const firstSource = {...f.input.sources[0], commitContext: {trailers: 'NestOS-Task: source-one'}};
    const input = {...f.input, coordinationTaskId:'coordination-task',sources: [firstSource, {...f.input.sources[0], directory: '/workspace/second'}]};
    expect(await tryGitIntegration(f.process, input)).toBe('applied');
    const target = await f.git('rev-parse', 'HEAD');
    expect(await inspectGitIntegration(f.process, input)).toBe(target);
    expect(await f.git('show', 'HEAD:shared')).toBe(first.replace('line 24\n', 'source two\n').trim());
    expect(await f.git('log', '-1', '--format=%(trailers:only)', 'HEAD^')).toBe('NestOS-Task: source-one\nNestOS-Coordination-Task: coordination-task');
    expect(await f.git('log', '-1', '--format=%(trailers:only)', 'HEAD')).toBe('NestOS-Coordination-Task: coordination-task');
    await expect(inspectGitIntegration(f.process,{...input,coordinationTaskId:'another-task'}))
        .rejects.toMatchObject({code:'INTEGRATION_COORDINATION_ID_MISMATCH'});
});

it('records a no-op when the frozen source is already integrated', async () => {
    const f = await fixture();
    const input = {...f.input, sources: [{...f.input.sources[0], repositories: []}]};
    expect(await tryGitIntegration(f.process, input)).toBe('applied');
    expect(await inspectGitIntegration(f.process, input)).toBe(input.previousTarget);
    expect(await f.git('rev-parse', 'HEAD')).toBe(input.previousTarget);
});


const publicationBoundaries=[
    '    match_work "$new_work" "$original_tree" || stop 5 INTEGRATION_RECOVERY_WORKTREE_CHANGED',
    '    [ "$(git write-tree)" = "$new_index" ] || stop 5 INTEGRATION_RECOVERY_INDEX_CHANGED',
    "    {\n        printf 'start",
];
async function interruptPublication(f:Awaited<ReturnType<typeof fixture>>,boundary:string) {
    const process={nativeShell:{async exec(program:string,args:string[],options?:{cwd?:string}){
        if(args[2]==='nestos-integration'){
            expect(args[1]).toContain(boundary);
            args=[args[0],args[1].replace(boundary,'    exit 91\n'+boundary),...args.slice(2)];
        }
        return f.process.nativeShell.exec(program,args,options);
    }}};
    await expect(tryGitIntegration(process,f.input)).rejects.toMatchObject({code:'INTEGRATION_PUBLICATION_UNKNOWN'});
    expect(await inspectGitIntegration(f.process,f.input)).toBeUndefined();
}

it.each(publicationBoundaries)('resumes the original transaction after interruption at %s',async boundary=>{
    const f=await fixture();
    await writeFile(join(f.source,'shared'),contents.replace('line 1\n','source\n'));
    await writeFile(join(f.source,'new'),'new file\n');
    const staged=contents.replace('line 12\n','staged\n');
    const unstaged=staged.replace('line 24\n','unstaged\n');
    await writeFile(join(f.root,'shared'),staged);await f.git('add','shared');
    await writeFile(join(f.root,'shared'),unstaged);
    await interruptPublication(f,boundary);
    expect(await f.git('rev-parse','HEAD')).toBe(f.input.previousTarget);
    const actual=await resumeGitIntegration(f.process,f.input);
    expect(actual).toBe(await f.git('rev-parse','HEAD'));
    expect(await resumeGitIntegration(f.process,f.input)).toBe(actual);
    expect(await f.git('show',':shared')).toBe(staged.replace('line 1\n','source\n').trim());
    expect(await readFile(join(f.root,'shared'),'utf8')).toBe(unstaged.replace('line 1\n','source\n'));
    expect(await f.git('show','HEAD:new')).toBe('new file');
});

it('preserves a concurrent edit and identifies the changed path during recovery',async()=>{
    const f=await fixture();
    await writeFile(join(f.source,'shared'),contents.replace('line 1\n','source\n'));
    await interruptPublication(f,publicationBoundaries[0]);
    await writeFile(join(f.root,'shared'),'concurrent user edit\n');
    await expect(resumeGitIntegration(f.process,f.input)).rejects.toMatchObject({
        code:'INTEGRATION_RECOVERY_WORKTREE_CHANGED',result:{integrationPaths:expect.arrayContaining(['shared'])}});
    expect(await readFile(join(f.root,'shared'),'utf8')).toBe('concurrent user edit\n');
    expect(await f.git('rev-parse','HEAD')).toBe(f.input.previousTarget);
});

it.each(['exact payload', 'other payload'])('checks hydrated Git LFS content after interruption (%s)',async payload=>{
    const f=await fixture(),asset=join(f.root,'asset.dat'),content='exact payload\n';
    const digest=createHash('sha256').update(content).digest('hex');
    await writeFile(join(f.root,'.gitattributes'),'asset.dat filter=lfs -text\n');
    await f.git('config','filter.lfs.clean','cat');
    await writeFile(asset,`version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${content.length}\n`);
    await f.git('add','.gitattributes','asset.dat');
    await f.git('commit','-qm','LFS pointer');
    const previousTarget=await f.git('rev-parse','HEAD');
    await f.git('-C',f.source,'merge','--ff-only',previousTarget);
    await writeFile(join(f.source,'shared'),contents.replace('line 1\n','source\n'));
    const input={...f.input,previousTarget,sources:[{...f.input.sources[0],sourceHead:previousTarget,
        repositories:[{path:'.',head:previousTarget,dirty:true}]}]};
    await interruptPublication({...f,input},publicationBoundaries[0]);
    await writeFile(asset,payload+'\n');
    if(payload==='exact payload')expect(await resumeGitIntegration(f.process,input)).toBe(await f.git('rev-parse','HEAD'));
    else await expect(resumeGitIntegration(f.process,input)).rejects.toMatchObject({
        code:'INTEGRATION_RECOVERY_WORKTREE_CHANGED',result:{integrationPaths:expect.arrayContaining(['asset.dat'])}});
    expect(await readFile(asset,'utf8')).toBe(payload+'\n');
});

it.each(['source','target'] as const)('publishes the selected %s Git stage from the frozen conflict plan',async choice=>{
    const f=await fixture(),target=contents.replace('line 1\n','target edit\n'),source=contents.replace('line 1\n','source edit\n');
    await writeFile(join(f.root,'shared'),target);await f.git('add','shared');await f.git('commit','-qm','target edit');
    await writeFile(join(f.source,'shared'),source);
    const input={...f.input,previousTarget:await f.git('rev-parse','HEAD'),approval:{selections:{shared:choice},
        plan:{conflicts:[{id:'shared',path:'shared',options:[{id:'source'},{id:'target'}]}]}}};
    expect(await tryGitIntegration(f.process,input)).toBe('applied');
    expect(await inspectGitIntegration(f.process,input)).toBe(await f.git('rev-parse','HEAD'));
    expect(await f.git('show','HEAD:shared')).toBe((choice==='source'?source:target).trim());
});


it('publishes only the approved custom conflict blob and computes unrelated paths itself',async()=>{
    const f=await fixture();
    await writeFile(join(f.root,'shared'),contents.replace('line 1\n','target edit\n'));await f.git('add','shared');await f.git('commit','-qm','target edit');
    await writeFile(join(f.source,'shared'),contents.replace('line 1\n','source edit\n'));
    await writeFile(join(f.source,'approved-new'),'ordinary source content\n');
    const approval={selections:{shared:'combine'},plan:{conflicts:[{id:'shared',path:'shared',options:[{id:'combine'}]}]}};
    const input={...f.input,previousTarget:await f.git('rev-parse','HEAD'),approval};
    expect(await tryGitIntegration(f.process,input)).toBe('session');
    await writeFile(join(f.source,'proposal'),contents.replace('line 1\n','combined\n'));
    const oid=await f.git('-C',f.source,'hash-object','-w','proposal');
    const proposal={path:'shared',choice:'combine',mode:'100644',oid};
    expect(()=>validateGitConflictResolutions(approval,[{...proposal,path:'approved-new'}])).toThrow('OPERATION_RESULT_INTEGRATION_PROPOSAL_INVALID');
    const resolutions=validateGitConflictResolutions(approval,[proposal]);
    await rm(join(f.source,'proposal'));
    expect(await tryGitIntegration(f.process,{...input,resolutions})).toBe('applied');
    expect(await inspectGitIntegration(f.process,{...input,resolutions})).toBe(await f.git('rev-parse','HEAD'));
    expect(await f.git('show','HEAD:shared')).toBe(contents.replace('line 1\n','combined\n').trim());
    expect(await f.git('show','HEAD:approved-new')).toBe('ordinary source content');
});

it('advances an existing gitlink without checking out or staging the populated submodule',async()=>{
    const f=await fixture(),repo=await mkdtemp(join(tmpdir(),'nestos-integration-module-'));
    roots.push(repo);
    await f.git('init','-qb','main',repo);
    await f.git('-C',repo,'config','user.name','Fixture');
    await f.git('-C',repo,'config','user.email','fixture@example.test');
    await writeFile(join(repo,'history'),'first\n');await f.git('-C',repo,'add','history');await f.git('-C',repo,'commit','-qm','first');
    const old=await f.git('-C',repo,'rev-parse','HEAD');
    await writeFile(join(repo,'history'),'second\n');await f.git('-C',repo,'add','history');await f.git('-C',repo,'commit','-qm','second');
    const next=await f.git('-C',repo,'rev-parse','HEAD'),module=join(f.root,'module');
    await f.git('-c','protocol.file.allow=always','submodule','add','--',repo,'module');
    await f.git('-C',module,'checkout','--detach',old);
    await f.git('add','.gitmodules','module');await f.git('commit','-qm','module base');
    const previousTarget=await f.git('rev-parse','HEAD');
    await f.git('-C',f.source,'merge','--ff-only',previousTarget);
    await f.git('-C',f.source,'update-index','--cacheinfo',`160000,${next},module`);
    await f.git('-C',f.source,'commit','-qm','advance module');
    const sourceHead=await f.git('-C',f.source,'rev-parse','HEAD');
    await writeFile(join(module,'history'),'staged local\n');await f.git('-C',module,'add','history');
    await writeFile(join(module,'history'),'unstaged local\n');
    const input={...f.input,previousTarget,sources:[{directory:'/workspace/source',sourceHead,
        repositories:[{path:'.',head:sourceHead,dirty:false},{path:'module',head:next,dirty:false}]}]};
    expect(await tryGitIntegration(f.process,input)).toBe('applied');
    expect(await inspectGitIntegration(f.process,input)).toBe(await f.git('rev-parse','HEAD'));
    expect(await f.git('ls-tree','HEAD','module')).toContain(next);
    expect(await f.git('-C',module,'rev-parse','HEAD')).toBe(old);
    expect(await f.git('-C',module,'show',':history')).toBe('staged local');
    expect(await readFile(join(module,'history'),'utf8')).toBe('unstaged local\n');
});


it('rejects source content changed after the approved tree was captured',async()=>{
    const f=await fixture();
    const file=join(f.source,'shared');
    await writeFile(file,'approved content\n');
    const frozen=await f.process.nativeShell.exec('sh',['-c',integrationSourceSnapshotScript,'test',f.input.previousTarget],{cwd:'/workspace/source'});
    expect(frozen.code).toBe(0);
    await writeFile(file,'new content on the same source HEAD\n');
    const input={...f.input,sources:[{...f.input.sources[0],sourceTree:frozen.stdout.trim()}]};
    await expect(tryGitIntegration(f.process,input)).rejects.toMatchObject({code:'INTEGRATION_SOURCE_CHANGED',executionOutcome:'not-started'});
    expect(await f.git('rev-parse','HEAD')).toBe(f.input.previousTarget);
    expect(await f.git('-C',f.source,'diff','--cached','--name-only')).toBe('');
    expect(await readFile(file,'utf8')).toBe('new content on the same source HEAD\n');
});

it('reports an external index change without resetting its staged blob',async()=>{
    const f=await fixture();
    await writeFile(join(f.source,'shared'),contents.replace('line 1\n','source\n'));
    await interruptPublication(f,publicationBoundaries[0]);
    await writeFile(join(f.root,'outside'),'user staged\n');
    await f.git('add','outside');
    await expect(resumeGitIntegration(f.process,f.input)).rejects.toMatchObject({
        code:'INTEGRATION_RECOVERY_INDEX_CHANGED',result:{integrationPaths:expect.arrayContaining(['outside'])}});
    expect(await f.git('show',':outside')).toBe('user staged');
    expect(await f.git('rev-parse','HEAD')).toBe(f.input.previousTarget);
});

it.each(['aligned','diverged','conflicted'])('publishes a frozen module snapshot without moving either module checkout (%s)',async variant=>{
    const f=await fixture(),repo=await mkdtemp(join(tmpdir(),'nestos-module-capture-'));
    roots.push(repo);
    await f.git('init','-qb','main',repo);
    await f.git('-C',repo,'config','user.name','Fixture');
    await f.git('-C',repo,'config','user.email','fixture@example.test');
    await writeFile(join(repo,'history'),'base\n');await f.git('-C',repo,'add','history');await f.git('-C',repo,'commit','-qm','base');
    const base=await f.git('-C',repo,'rev-parse','HEAD');
    await f.git('-c','protocol.file.allow=always','submodule','add','--',repo,'module');
    await f.git('commit','-qam','register module');
    const sourceHead=await f.git('rev-parse','HEAD');
    await f.git('-C',f.source,'merge','--ff-only',sourceHead);
    await f.git('-C',f.source,'-c','protocol.file.allow=always','submodule','update','--init','--','module');
    const sourceModule=join(f.source,'module'),targetModule=join(f.root,'module');
    if(variant!=='aligned'){
        await writeFile(join(targetModule,'target-only'),'retained\n');
        if(variant==='conflicted')await writeFile(join(targetModule,'history'),'target history\n');
        await f.git('-C',targetModule,'add','target-only','history');
        await f.git('-C',targetModule,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','target module change');
        await f.git('add','module');await f.git('commit','-qm','advance target module');
    }
    const previousTarget=await f.git('rev-parse','HEAD'),targetModuleHead=await f.git('-C',targetModule,'rev-parse','HEAD');
    const file=join(sourceModule,'history');
    await writeFile(file,'approved\n');
    const objects=JSON.stringify([['module',base]]);
    const trailers='NestOS-Task: execution-task\nNestOS-Coordination-Task: coordination-task';
    const frozen=await f.process.nativeShell.exec('sh',['-c',integrationSourceSnapshotScript,'test',sourceHead,objects,trailers],{cwd:'/workspace/source'});
    expect(frozen).toMatchObject({code:0});
    const input:GitIntegrationTransaction={...f.input,previousTarget,coordinationTaskId:'coordination-task',sources:[{...f.input.sources[0],taskId:'execution-task',
        moduleTrailers:trailers,sourceHead,sourceTree:frozen.stdout.trim(),
        repositories:[{path:'.',head:sourceHead,dirty:true},{path:'module',head:base,dirty:true}]}]};
    await writeFile(file,'changed after review\n');
    await expect(tryGitIntegration(f.process,input)).rejects.toMatchObject({code:'INTEGRATION_SOURCE_CHANGED'});
    expect(await f.git('rev-parse','HEAD')).toBe(previousTarget);
    await writeFile(file,'approved\n');
    const history=variant==='conflicted'?'merged history':'approved';
    if(variant==='conflicted'){
        await expect(tryGitIntegration(f.process,input)).rejects.toMatchObject({code:'MERGE_PLAN_CONFLICTS_MISSING'});
        const path='module/history', proposed=join(f.root,'resolution');
        await writeFile(proposed,history+'\n');
        const oid=await f.git('-C',sourceModule,'hash-object','-w','--no-filters',proposed);
        await expect(f.git('-C',targetModule,'cat-file','-e',oid)).rejects.toThrow();
        input.approval={selections:{history:'combined'},plan:{conflicts:[{id:'history',path,options:[{id:'combined'}]}]}};
        const recorded=[{path,choice:'combined',mode:'100644' as const,oid}];
        await expect(tryGitIntegration(f.process,{...input,resolutions:[{...recorded[0],oid:'b'.repeat(40)}]}))
            .rejects.toMatchObject({code:'INTEGRATION_APPROVED_BLOB_MISSING',executionOutcome:'not-started'});
        input.resolutions=recorded;
    }
    expect(await tryGitIntegration(f.process,input)).toBe('applied');
    const link=/^160000 commit ([a-f0-9]+)\s/.exec(await f.git('ls-tree','HEAD','module'))?.[1];
    expect(link).toBeDefined();
    expect(await f.git('-C',targetModule,'show',link+':history')).toBe(history);
    expect(await f.git('-C',targetModule,'show','-s','--format=%(trailers:only)',link!)).toBe(trailers);
    expect(await f.git('-C',targetModule,'rev-parse','refs/nestos/module-delivery/'+link)).toBe(link);
    expect(await f.git('-C',targetModule,'rev-parse','HEAD')).toBe(targetModuleHead);
    if(variant!=='aligned')expect(await f.git('-C',targetModule,'show',link+':target-only')).toBe('retained');
    expect(await f.git('-C',sourceModule,'rev-parse','HEAD')).toBe(base);
    expect(await f.git('-C',sourceModule,'diff','--cached','--name-only')).toBe('');
    expect(await readFile(file,'utf8')).toBe('approved\n');
    await writeFile(file,'later task work\n');
    expect(await inspectGitIntegration(f.process,input)).toBe(await f.git('rev-parse','HEAD'));
});
