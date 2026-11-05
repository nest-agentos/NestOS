import {kanbanConfigurationDefaults} from '../resources/catalog';
import {createModuleLogger,randomUUID,sha256HexSync} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import {readPrompt,failure} from '../run/prompt-bundle';
const log=createModuleLogger('kanban-configuration');
export const KANBAN_CONFIGURATION_DIRECTORY='/etc/kanban';

/** Only a changed shipped bundle replaces global defaults; ordinary restarts preserve edits. */
export function ensureKanbanConfiguration(fs:IFileSystem,readonly=false):Promise<void> {
    return installConfiguration(fs,{readonly,force:false});
}
export function restoreKanbanConfiguration(fs:IFileSystem):Promise<void> {
    return installConfiguration(fs,{readonly:false,force:true});
}
async function installConfiguration(fs:IFileSystem,options:{readonly:boolean;force:boolean}):Promise<void> {
    const operationId=randomUUID(),started=Date.now(),version=sha256HexSync(JSON.stringify(kanbanConfigurationDefaults));
    const marker=KANBAN_CONFIGURATION_DIRECTORY+'/.defaults.json',stage=options.force?'restore':'upgrade';
    try {
        if(!options.force&&await fs.driver.exists(marker)){
            let installed:{version?:string};try{installed=JSON.parse(await readPrompt(fs,marker));}catch{throw failure('KANBAN_CONFIGURATION_VERSION_INVALID');}
            if(!installed||typeof installed.version!=='string')throw failure('KANBAN_CONFIGURATION_VERSION_INVALID');
            if(installed.version===version)return;
        }
        if(options.readonly)throw failure('KANBAN_CONFIGURATION_UPGRADE_REQUIRED');
        await write(fs,KANBAN_CONFIGURATION_DIRECTORY,'.defaults.json',JSON.stringify({schema:1,version:'pending',targetVersion:version,generation:operationId})+'\n');
        const directory=KANBAN_CONFIGURATION_DIRECTORY+'/development';
        for(const [name,content] of Object.entries(kanbanConfigurationDefaults))await write(fs,directory,name,content);
        await write(fs,directory,'profile.json',JSON.stringify({schema:1,files:Object.keys(kanbanConfigurationDefaults)},null,2)+'\n');
        await write(fs,KANBAN_CONFIGURATION_DIRECTORY,'.defaults.json',JSON.stringify({schema:1,version,generation:operationId})+'\n');
        log.info('Global configuration installed',{operation:'kanban.configuration',operationId,stage,result:'success',count:Object.keys(kanbanConfigurationDefaults).length,durationMs:Date.now()-started});
    }catch(error){
        const code=(error as {code?:string}).code??(options.force?'KANBAN_CONFIGURATION_RESTORE_FAILED':'KANBAN_CONFIGURATION_UPGRADE_FAILED');
        log.warn('Global configuration unavailable',{operation:'kanban.configuration',operationId,stage,result:'failure',code,durationMs:Date.now()-started});throw error;
    }
}
async function write(fs:IFileSystem,directory:string,name:string,content:string):Promise<void> {
    if(await fs.driver.exists(directory+'/'+name))await fs.driver.writeContent(directory+'/'+name,content);
    else await fs.driver.createFile({parentPath:directory,name,content,recursive:true});
}

/** A restore can replace the same version; generation fences concurrent configuration readers. */
export async function kanbanConfigurationRevision(fs:IFileSystem):Promise<string|undefined> {
    const path=KANBAN_CONFIGURATION_DIRECTORY+'/.defaults.json';
    if(!await fs.driver.exists(path))return;
    const text=await readPrompt(fs,path);
    let marker:{version?:string};try{marker=JSON.parse(text);}catch{throw failure('KANBAN_CONFIGURATION_VERSION_INVALID');}
    if(marker?.version==='pending')throw failure('KANBAN_CONFIGURATION_UPDATE_PENDING');
    if(typeof marker?.version!=='string')throw failure('KANBAN_CONFIGURATION_VERSION_INVALID');
    return sha256HexSync(text);
}
