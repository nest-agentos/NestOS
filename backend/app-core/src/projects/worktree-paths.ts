import type {RemoteProcessHandle} from './remote-mounts';
import {requireValue} from '../kanban/validation';
const roots=new WeakMap<RemoteProcessHandle,Promise<string>>();

/** CWD is translated by Cells; absolute argv paths must use that process's real project root. */
export async function processWorkspacePath(process:RemoteProcessHandle,path:string):Promise<string> {
    requireValue((path==='/workspace'||path.startsWith('/workspace/'))&&!path.split('/').some(part=>part==='.'||part==='..'),'WORKTREE_SCOPE_INVALID');
    const root=await workspaceRoot(process);return root+path.slice('/workspace'.length);
}
export async function worktreeArguments(process:RemoteProcessHandle,args:string[]):Promise<string[]> {
    if(args[0]!=='worktree'||!['add','remove','move','repair'].includes(args[1]))return args;
    return Promise.all(args.map(arg=>arg.startsWith('/workspace/')?processWorkspacePath(process,arg):arg));
}
export async function logicalWorktreeListing(process:RemoteProcessHandle,stdout:string):Promise<string> {
    const root=await workspaceRoot(process);
    return stdout.replace(/^worktree (.+)$/gm,(line,path:string)=>path===root||path.startsWith(root+'/')?'worktree /workspace'+path.slice(root.length):line);
}
function workspaceRoot(process:RemoteProcessHandle):Promise<string> {
    let pending=roots.get(process);
    if(!pending){pending=readRoot(process).catch(error=>{roots.delete(process);throw error;});roots.set(process,pending);}
    return pending;
}
async function readRoot(process:RemoteProcessHandle):Promise<string> {
    const result=await process.nativeShell.exec('git',['rev-parse','--show-toplevel'],{cwd:'/workspace',timeoutMs:30000});
    requireValue(result.code===0,'GIT_WORKSPACE_PATH_FAILED');const root=result.stdout.trim().replace(/\/$/,'');
    requireValue(root.startsWith('/')&&!/[\r\n\0]/.test(root)&&!root.split('/').some(part=>part==='.'||part==='..'),'GIT_WORKSPACE_PATH_FAILED');
    return root;
}
