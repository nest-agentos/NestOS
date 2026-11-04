import type {IFileSystem} from '@nestos/vfs-core';
import type {Definition,Options,SavedFix} from './task-fix-contracts';
import {parseSessionFile} from '../run/session-file-result';
import {requireValue} from './validation';
export function parseDefinition(text:string,originalId:string):Definition {
    const value=parseSessionFile(text) as Definition&{schema:string};
    requireValue(value?.schema==='kanban.fix-proposal/1'&&value.type==='fix','FIX_DEFINITION_INVALID');
    requireValue(['title','responsibility','acceptance'].every(key=>typeof value[key as keyof Definition]==='string'&&String(value[key as keyof Definition]).trim().length>0&&String(value[key as keyof Definition]).length<=8000),'FIX_DEFINITION_INVALID');
    requireValue(Array.isArray(value.dependencies)&&value.dependencies.length===1&&value.dependencies[0]===originalId,'FIX_DEPENDENCY_REQUIRED');
    return {title:value.title,responsibility:value.responsibility,acceptance:value.acceptance,type:'fix',dependencies:[originalId]};
}
export async function inWorkspace<T>(options:Options,fix:SavedFix,run:(fs:IFileSystem,directory:string)=>Promise<T>):Promise<T> {
    const project=await options.automation.projects!.get(fix.projectId),view=await options.automation.projects!.openWorkspace!(project.path);
    try{return await run(view.fs,'/workspace/_nestos/worktrees/'+fix.id+'/_nestos/kanban/fix/'+fix.id);}finally{await view.dispose();}
}
