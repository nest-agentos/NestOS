import {kanbanConfigurationDefaults} from '../resources/catalog';
import type {IFileSystem} from '@nestos/vfs-core';
import {LIFECYCLE_PROMPT_SUFFIXES} from '../run/prompt-lifecycle';
import {createModuleLogger,randomUUID,sha256HexSync} from '@nestos/common';
import {readPrompt,failure,type PromptFile} from '../run/prompt-bundle';
import {KANBAN_CONFIGURATION_DIRECTORY,kanbanConfigurationRevision} from './kanban-global-configuration';
const log=createModuleLogger('kanban-configuration');
const validName=(name:unknown):name is string=>typeof name==='string'&&/^[a-zA-Z0-9_-]+\.(md|json|yaml|yml|txt)$/.test(name)&&name!=='profile.json';
/** A bounded manifest selects data files; no file can authorize execution or escape its profile. */
export async function resolveKanbanConfiguration(fs:IFileSystem,project:IFileSystem,profile:string):Promise<PromptFile[]> {
    const operationId=randomUUID(),started=Date.now();
    try{const revision=await kanbanConfigurationRevision(fs),files=await resolveFiles(fs,project,profile);
        if(await kanbanConfigurationRevision(fs)!==revision)throw failure('KANBAN_CONFIGURATION_CHANGED');
        log.info('Configuration resolved',{operation:'kanban.configuration',operationId,stage:'resolve',result:'success',profile,count:files.length,durationMs:Date.now()-started});return files;
    }catch(error){const value=error as {code?:string;file?:string};
        log.warn('Configuration unavailable',{operation:'kanban.configuration',operationId,stage:'resolve',result:'failure',profile,file:value.file,code:value.code??'KANBAN_CONFIGURATION_READ_FAILED',durationMs:Date.now()-started});throw error;
    }
}
async function resolveFiles(fs:IFileSystem,project:IFileSystem,profile:string):Promise<PromptFile[]> {
    const global=KANBAN_CONFIGURATION_DIRECTORY+'/'+profile,local='/workspace/_nestos/etc/kanban/'+profile;
    const manifest=await selected(fs,project,global,local,'profile.json');
    let names:string[];
    if(manifest){
        let value:{schema?:number;files?:unknown};try{value=JSON.parse(manifest.content);}catch{throw failure('KANBAN_PROFILE_INVALID');}
        if(!value||value.schema!==1||!Array.isArray(value.files)||value.files.length>31||!value.files.every(validName)||new Set(value.files).size!==value.files.length)throw failure('KANBAN_PROFILE_INVALID');
        names=value.files;
        if(['decision.md','task.md','planning.md','bootstrap.md'].some(name=>!names.includes(name)))throw failure('KANBAN_PROFILE_REQUIRED_FILE');
    }else{if(profile!=='development'||await fs.driver.exists(KANBAN_CONFIGURATION_DIRECTORY+'/.defaults.json'))throw failure('PROMPT_PROFILE_NOT_FOUND');names=Object.keys(kanbanConfigurationDefaults);}
    const files:PromptFile[]=manifest?[manifest]:[];
    const optional=['decision','task'].flatMap(entry=>LIFECYCLE_PROMPT_SUFFIXES.map(suffix=>entry+'-'+suffix+'.md'));
    for(const name of new Set([...names,...optional])){
        const file=await selected(fs,project,global,local,name);
        if(file)files.push(file);
        else {const content=kanbanConfigurationDefaults[name as keyof typeof kanbanConfigurationDefaults];
            if(!names.includes(name))continue;
            if(manifest||!content)throw Object.assign(failure('KANBAN_PROFILE_FILE_MISSING'),{file:name});files.push({name,content,source:'builtin:'+name,sha256:sha256HexSync(content)});}
    }
    return files;
}
async function selected(fs:IFileSystem,project:IFileSystem,global:string,local:string,name:string):Promise<PromptFile|undefined> {
    const isLocal=await project.driver.exists(local+'/'+name),source=isLocal?project:fs,path=(isLocal?local:global)+'/'+name;
    if(!await source.driver.exists(path))return;
    const content=await readPrompt(source,path);return {name,content,source:(isLocal?'project:':'nestos:')+path,sha256:sha256HexSync(content)};
}

export async function readGlobalPlanningPrompt(fs:IFileSystem,profile:string):Promise<string> {
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(profile))throw failure('DEVELOPMENT_POLICY_INVALID');
    const path=KANBAN_CONFIGURATION_DIRECTORY+'/'+profile+'/planning.md';
    if(await fs.driver.exists(path)){
        const revision=await kanbanConfigurationRevision(fs),content=await readPrompt(fs,path);
        if(await kanbanConfigurationRevision(fs)!==revision)throw failure('KANBAN_CONFIGURATION_CHANGED');return content;
    }
    if(profile!=='development'||await fs.driver.exists(KANBAN_CONFIGURATION_DIRECTORY+'/.defaults.json'))throw failure('KANBAN_PROFILE_FILE_MISSING');
    return kanbanConfigurationDefaults['planning.md'];
}
