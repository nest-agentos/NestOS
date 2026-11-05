import {t} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {InitialResourceProvider} from './initial-files';
import {kanbanConfigurationDefaults} from '../resources/catalog';
import {KANBAN_CONFIGURATION_DIRECTORY,restoreKanbanConfiguration} from './kanban-global-configuration';

/** Explicit recovery uses the same complete bundle and installer as startup and upgrades. */
export function kanbanConfigurationResources(fs:IFileSystem,existing?:InitialResourceProvider):InitialResourceProvider {
    const id='kanban:global-configuration',directory=KANBAN_CONFIGURATION_DIRECTORY+'/development';
    return {async list(){
        const paths=[...Object.keys(kanbanConfigurationDefaults),'profile.json'].map(name=>directory+'/'+name);
        paths.push(KANBAN_CONFIGURATION_DIRECTORY+'/.defaults.json');
        const present=await Promise.all(paths.map(path=>fs.driver.exists(path)));
        return [...await existing?.list()??[],{id,group:'kanban' as const,name:t('kanban.globalConfiguration'),path:directory,overwrite:true,exists:present.every(Boolean)}];
    },async restore(value){
        if(value!==id)return existing?.restore(value)??false;
        await restoreKanbanConfiguration(fs);return true;
    }};
}
