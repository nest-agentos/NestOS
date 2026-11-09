import {operationScope,checkOperation} from '@nestos/vfs-core';
import {mapConcurrent} from '../utils/map-concurrent';
import {createModuleLogger,randomUUID,t} from '@nestos/common';
import type {HarnessProfile} from '@nestos/cells-driver';
import type {KanbanBoard,KanbanBoardSettingsCatalog} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import {requireValue} from '../kanban/validation';
export type KanbanHarnessRole='decision'|'coordination'|'execution';
export const harnessSettingKey=(role:KanbanHarnessRole)=>'harness-'+role;
const roles:KanbanHarnessRole[]=['decision','coordination','execution'];
const log=createModuleLogger('kanban-harness-settings');
export function kanbanHarnessSettings(remote:ProjectRemoteMountService){
    const catalog=async(board:KanbanBoard):Promise<KanbanBoardSettingsCatalog>=>{
        const profiles=await availableProfiles(remote);
        return {description:t('kanban.harnessSettingsHelp'),fields:roles.map(role=>{
            const value=board.settings?.[harnessSettingKey(role)];const choices=[{value:'',label:t('kanban.harnessDefault'),disabled:false},...profiles.values()];
            if(value && !profiles.has(value))choices.push({value,label:value+' · '+t('kanban.harnessUnavailable'),disabled:true});
            return {name:harnessSettingKey(role),label:t(('kanban.harnessRole.'+role) as Parameters<typeof t>[0]),choices};
        })};
    };
    return {catalog,validate:async(board:KanbanBoard,settings:Record<string,string>)=>{
        requireValue(Object.keys(settings).every(key=>roles.some(role=>harnessSettingKey(role)===key)),'KANBAN_SETTINGS_UNKNOWN_FIELD');
        const view=await catalog(board);
        for(const field of view.fields){const value=settings[field.name]??'';
            requireValue(!value || value===board.settings?.[field.name] || field.choices.some(choice=>choice.value===value&&!choice.disabled),'KANBAN_HARNESS_UNAVAILABLE');}
    }};
}
async function availableProfiles(remote:ProjectRemoteMountService){
    const operationId=randomUUID(),started=Date.now(),scope=operationScope({timeoutMs:3000});
    const profiles=new Map<string,{value:string;label:string;disabled:boolean}>(),projects=new Map<string,string>();
    for(const id of remote.mountedProjectIds()){
        const root=remote.list(id).find(m=>m.at==='/');if(!root?.connectionId)continue;
        if(!projects.has(root.connectionId)||root.capabilities?.sessionControl===true)projects.set(root.connectionId,id);
    }
    try{await mapConcurrent([...projects.values()],4,async projectId=>{
        let client:Awaited<ReturnType<ProjectRemoteMountService['projectHarness']>>|undefined;
        try{checkOperation(scope.options);client=await remote.projectHarness(projectId,scope.options);
            for(const profile of (await client.profiles(scope.options)).profiles){
                const disabled=!eligible(profile),existing=profiles.get(profile.id);
                if(!existing||existing.disabled&&!disabled)profiles.set(profile.id,{value:profile.id,label:profile.id+' ('+profile.kind+')'+(disabled?' · '+t('kanban.harnessCapabilitiesMissing'):''),disabled});
            }
        }catch(error){log.warn('kanban.settings.catalog',{operationId,stage:'profiles',result:'failure',projectId,code:(error as {code?:string})?.code??'HARNESS_UNAVAILABLE',durationMs:Date.now()-started});}
        finally{await client?.close();}
    });}finally{scope.dispose();}
    log.info('kanban.settings.catalog',{operationId,stage:'complete',result:'success',count:profiles.size,durationMs:Date.now()-started});return profiles;
}

function eligible(profile:HarnessProfile):boolean{
    return !!profile.projectRuntime && profile.capabilities.create && !!profile.capabilities.sessionChannels && !!profile.capabilities.workingDirectory;
}
export function selectKanbanHarness(profiles:HarnessProfile[],workspaceId:string,selected?:string):HarnessProfile{
    const profile=selected?profiles.find(p=>p.id===selected || p.aliases?.includes(selected)):profiles.find(p=>eligible(p)&&p.workspaces.some(w=>w.id===workspaceId));
    requireValue(profile,'KANBAN_HARNESS_UNAVAILABLE');requireValue(eligible(profile)&&profile.workspaces.some(w=>w.id===workspaceId),'KANBAN_HARNESS_CAPABILITIES_REQUIRED');return profile;
}
export async function freezeKanbanHarness(journal:KanbanAutomationJournal,id:string,boardId:string,role:KanbanHarnessRole,profileId:string):Promise<string>{
    const binding=await journal.update<{boardId:string;role:KanbanHarnessRole;profileId:string}>('kanban-harness-choice:'+id,old=>old??{boardId,role,profileId});
    requireValue(binding.boardId===boardId && binding.role===role,'KANBAN_HARNESS_BINDING_CHANGED');return binding.profileId;
}
