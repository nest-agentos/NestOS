import {createModuleLogger,randomUUID,sha256HexSync} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import defaults from './kanban-development-prompts.json';
import maintenance from './kanban-maintenance-prompts.json';
import {readPrompt,failure} from '../run/prompt-bundle';
const log=createModuleLogger('kanban-configuration');
export const KANBAN_CONFIGURATION_DIRECTORY='/etc/kanban';
export const kanbanConfigurationDefaults={...defaults,...maintenance};
/** Only a changed shipped bundle replaces global defaults; ordinary restarts preserve edits. */
export async function ensureKanbanConfiguration(fs:IFileSystem,readonly=false):Promise<void> {
    const operationId=randomUUID(),started=Date.now(),version=sha256HexSync(JSON.stringify(kanbanConfigurationDefaults));
    const marker=KANBAN_CONFIGURATION_DIRECTORY+'/.defaults.json';
    try {
        if(await fs.driver.exists(marker)){
            let installed:{version?:string};try{installed=JSON.parse(await readPrompt(fs,marker));}catch{throw failure('KANBAN_CONFIGURATION_VERSION_INVALID');}
            if(!installed||typeof installed.version!=='string')throw failure('KANBAN_CONFIGURATION_VERSION_INVALID');
            if(installed.version===version)return;
        }
        if(readonly)throw failure('KANBAN_CONFIGURATION_UPGRADE_REQUIRED');
        const directory=KANBAN_CONFIGURATION_DIRECTORY+'/development';
        for(const [name,content] of Object.entries(kanbanConfigurationDefaults))await write(fs,directory,name,content);
        await write(fs,directory,'profile.json',JSON.stringify({schema:1,files:Object.keys(kanbanConfigurationDefaults)},null,2)+'\n');
        await write(fs,KANBAN_CONFIGURATION_DIRECTORY,'.defaults.json',JSON.stringify({schema:1,version})+'\n');
        log.info('Global configuration installed',{operation:'kanban.configuration',operationId,stage:'upgrade',result:'success',count:Object.keys(kanbanConfigurationDefaults).length,durationMs:Date.now()-started});
    }catch(error){
        const code=(error as {code?:string}).code??'KANBAN_CONFIGURATION_UPGRADE_FAILED';
        log.warn('Global configuration unavailable',{operation:'kanban.configuration',operationId,stage:'upgrade',result:'failure',code,durationMs:Date.now()-started});throw error;
    }
}
async function write(fs:IFileSystem,directory:string,name:string,content:string):Promise<void> {
    if(await fs.driver.exists(directory+'/'+name))await fs.driver.writeContent(directory+'/'+name,content);
    else await fs.driver.createFile({parentPath:directory,name,content,recursive:true});
}
