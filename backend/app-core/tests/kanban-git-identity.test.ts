import{afterEach,expect,it,vi}from'vitest';
import{mkdtemp,mkdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{readGitCommitIdentity}from'../src/presets/kanban-git-identity';
import{openDevelopmentChannel,type DevelopmentWorkspaceRecord}from'../src/presets/kanban-development';
const exec=promisify(execFile),roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'nestos-git-identity-'));roots.push(directory);const home=join(directory,'home');await mkdir(home);
 const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'config'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const git=async(args:string[])=>exec('git',args,{cwd:directory,env});await git(['init','-b','main']);
 const processHandle={nativeShell:{exec:async(_name:string,args:string[])=>{try{const result=await git(args);return{code:0,stdout:result.stdout,stderr:result.stderr};}catch(e){const error=e as{code:number;stdout:string;stderr:string};return{code:error.code,stdout:error.stdout??'',stderr:error.stderr??''};}}}} as never;
 return{git,processHandle};
}
it('reads the explicitly configured project identity with an isolated HOME',async()=>{
 const f=await fixture();await f.git(['config','user.name','Project Automation']);await f.git(['config','user.email','automation@example.invalid']);
 expect(await readGitCommitIdentity(f.processHandle)).toEqual({name:'Project Automation',email:'automation@example.invalid'});
});
it('rejects missing configuration without guessing an identity from host names or history',async()=>{
 const f=await fixture();await expect(readGitCommitIdentity(f.processHandle)).rejects.toMatchObject({code:'GIT_COMMIT_IDENTITY_REQUIRED'});
 await f.git(['config','user.name','Historical Author']);await f.git(['config','user.email','history@example.invalid']);await f.git(['commit','--allow-empty','-m','test: history']);
 await f.git(['config','--unset','user.name']);await f.git(['config','--unset','user.email']);
 await expect(readGitCommitIdentity(f.processHandle)).rejects.toMatchObject({code:'GIT_COMMIT_IDENTITY_REQUIRED'});
});
it('publishes the frozen identity in the channel policy for native Sessions and continuations',async()=>{
 const remote={sessionChannel:vi.fn(async()=>undefined)},gitIdentity={name:'Project Automation',email:'automation@example.invalid'};
 const record={projectId:'project',directory:'/workspace/task',channelId:'scope',gitIdentity,repositories:[],availableRepositories:[],policy:{commit:'worktree',prompts:{files:[]}}} as unknown as DevelopmentWorkspaceRecord;
 await openDevelopmentChannel(remote,'scope',record,{runId:'run',itemId:'task',attemptId:'scope'},{});
 expect(remote.sessionChannel).toHaveBeenCalledWith('project','open',expect.objectContaining({snapshot:expect.objectContaining({policy:expect.objectContaining({gitIdentity})})}));
});
