import {safeCode} from '@nestos/kanban/integration';
import {operationScope,checkOperation} from '@nestos/vfs-core';
import {mapConcurrent} from '../utils/map-concurrent';
import {createModuleLogger,randomUUID,t} from '@nestos/common';
import type {HarnessProfile} from '@nestos/cells-driver';
import type {KanbanBoard,KanbanBoardSettingsCatalog,KanbanExternalReference,KanbanStageHarnesses,KanbanStageHarnessModels,KanbanHarnessModelSelection,KanbanHarnessModel,KanbanHarnessStage} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import {requireValue} from '../kanban/validation';
export type KanbanHarnessRole=KanbanHarnessStage;
export const harnessSettingKey=(role:KanbanHarnessRole)=>'harness-'+role;
export const harnessSelectionKey=(role:KanbanHarnessRole)=>harnessSettingKey(role)+'-selection';
export const harnessRoles=['decision','coordination','execution'] as const;
export interface HarnessChoice {profileId:string;selection?:KanbanHarnessModelSelection}
export type ReadHarnessDefault=(role:KanbanHarnessRole)=>Promise<HarnessChoice|undefined>;
export async function preferredHarness(role:KanbanHarnessRole, settings?:Record<string,string>, readGlobal?:ReadHarnessDefault):Promise<HarnessChoice|undefined> {
    return readHarnessChoice(role,settings) ?? await readGlobal?.(role);
}
export function readHarnessChoice(role:KanbanHarnessRole,settings?:Record<string,string>):HarnessChoice|undefined {
    const profileId=settings?.[harnessSettingKey(role)];
    if(!profileId)return;
    const saved=storedHarnessSelection(settings?.[harnessSelectionKey(role)]);
    return {profileId,...(saved?.profileId===profileId?{selection:saved.selection}:{})};
}
function storedHarnessSelection(raw?:string):{profileId:string;selection:KanbanHarnessModelSelection}|undefined {
    if(!raw)return;
    let choice:{profileId?:unknown};
    try{choice=JSON.parse(raw);}catch{requireValue(false,'DECISION_HARNESS_SELECTION_INVALID');}
    requireValue(choice&&typeof choice.profileId==='string'&&choice.profileId.length<=128,'DECISION_HARNESS_SELECTION_INVALID');
    return {profileId:choice.profileId,selection:validateSelection(choice)};
}
function validateSelection(selection:unknown):KanbanHarnessModelSelection {
    const value=selection as KanbanHarnessModelSelection|null;
    requireValue(value&&typeof value.modelId==='string'&&value.modelId.length>0&&value.modelId.length<=256&&
        (value.reasoningEffort===undefined||typeof value.reasoningEffort==='string'&&value.reasoningEffort.length<=128),'DECISION_HARNESS_SELECTION_INVALID');
    return {modelId:value.modelId,...(value.reasoningEffort?{reasoningEffort:value.reasoningEffort}:{})};
}
const decisionHarnessSystem=(role:KanbanHarnessRole)=>'nestos-decision-harness-'+role;
export function decisionHarnessReferences(harnesses?:KanbanStageHarnesses,models?:KanbanStageHarnessModels):KanbanExternalReference[]{
    return harnessRoles.filter(role=>role!=='decision').flatMap(role=>{
        const id=harnesses?.[role],selection=models?.[role];
        return id?[{system:decisionHarnessSystem(role),id,...(selection?{revision:JSON.stringify(selection)}:{})}]:[];
    });
}
function decisionHarnessReference(context:unknown,role:KanbanHarnessRole):KanbanExternalReference|undefined {
    const decision=(context as {decision?:{snapshot?:{externalRefs?:KanbanExternalReference[]}}}|undefined)?.decision;
    return decision?.snapshot?.externalRefs?.find(ref=>ref.system===decisionHarnessSystem(role));
}
export function decisionHarnessProfile(context:unknown,role:KanbanHarnessRole):string|undefined {
    return decisionHarnessReference(context,role)?.id;
}
export function decisionHarnessModel(context:unknown,role:KanbanHarnessRole):KanbanHarnessModelSelection|undefined {
    const revision=decisionHarnessReference(context,role)?.revision;
    if(!revision)return;
    let selection:KanbanHarnessModelSelection;
    try{selection=JSON.parse(revision);}catch{requireValue(false,'DECISION_HARNESS_SELECTION_INVALID');}
    return validateSelection(selection);
}
export function harnessRetryTarget(target:KanbanExternalReference|undefined,role:KanbanHarnessRole):string|undefined {
    return target?.system===decisionHarnessSystem(role)?target.id:undefined;
}
export function harnessSelectionFailure(code:string|undefined):boolean {
    return ['KANBAN_HARNESS_UNAVAILABLE','KANBAN_HARNESS_WORKSPACE_MISMATCH','KANBAN_HARNESS_CAPABILITIES_REQUIRED','KANBAN_HARNESS_PERMISSION_REQUIRED','KANBAN_HARNESS_MODEL_UNAVAILABLE','KANBAN_HARNESS_EFFORT_UNAVAILABLE',
        'DECISION_AUTHORIZATION_CHANGED','EACCES','EPERM','FORBIDDEN'].includes(code??'');
}
export function selectProjectHarness(remote:ProjectRemoteMountService,projectId:string,selected:string,selection?:KanbanHarnessModelSelection):Promise<string> {
    return withProjectHarnessProfile(remote,projectId,selected,async(client,profile)=>{
        await requireHarnessModel(client,profile,selection);
        return profile.id;
    });
}
async function withProjectHarnessProfile<T>(remote:ProjectRemoteMountService,projectId:string,profileId:string,
    read:(client:import('@nestos/cells-driver').HarnessClient,profile:HarnessProfile)=>Promise<T>):Promise<T> {
    const client=await remote.projectHarness(projectId,{requireRegistered:true});
    try{
        const workspaceId=remote.list(projectId).find(mount=>mount.at==='/')?.serverProjectId;
        requireValue(workspaceId,'REMOTE_WORKSPACE_REQUIRED');
        return await read(client,selectKanbanHarness((await client.profiles()).profiles,workspaceId,profileId));
    }finally{await client.close();}
}
async function harnessModels(client:Pick<import('@nestos/cells-driver').HarnessClient,'models'>,profile:HarnessProfile,options?:import('@nestos/vfs-core').OperationOptions):Promise<KanbanHarnessModel[]> {
    if(!profile.capabilities.models||!client.models)return [];
    const {models}=await client.models(profile.id,undefined,options);
    return models.map(({id,label,reasoningEfforts})=>({id,label,reasoningEfforts}));
}
export async function requireHarnessModel(client:Pick<import('@nestos/cells-driver').HarnessClient,'models'>,profile:HarnessProfile,selection?:KanbanHarnessModelSelection):Promise<void> {
    if(!selection)return;
    requireAvailableSelection(await harnessModels(client,profile),selection);
}
function requireAvailableSelection(models:KanbanHarnessModel[],selection:KanbanHarnessModelSelection):void {
    const model=models.find(row=>row.id===selection.modelId);
    requireValue(model,'KANBAN_HARNESS_MODEL_UNAVAILABLE');
    requireValue(!selection.reasoningEffort||model.reasoningEfforts.some(row=>row.id===selection.reasoningEffort),'KANBAN_HARNESS_EFFORT_UNAVAILABLE');
}
async function projectHarnessModels(remote:ProjectRemoteMountService,projectId:string,profileId:string):Promise<KanbanHarnessModel[]> {
    const operationId=randomUUID(),started=Date.now(),stage='decision.harness.models';
    try{
        requireValue(typeof projectId==='string'&&projectId.length>0&&projectId.length<=256&&typeof profileId==='string'&&profileId.length>0&&profileId.length<=128,'DECISION_HARNESS_SELECTION_INVALID');
        const models=await withProjectHarnessProfile(remote,projectId,profileId,harnessModels);
        log.info('kanban.harness.models',{operationId,stage,result:'success',count:models.length,durationMs:Date.now()-started});
        return models;
    }catch(error){
        log.warn('kanban.harness.models',{operationId,stage,result:'failure',code:safeCode(error,'KANBAN_HARNESS_MODEL_UNAVAILABLE'),durationMs:Date.now()-started});
        throw error;
    }
}
export const harnessPreparationKey=(id:string)=>'kanban-harness-preparation:'+id;
export const coordinationHarnessScope=(boardId:string,itemId:string,epoch?:string)=>JSON.stringify([boardId,itemId,epoch??null]);
export interface HarnessPreparation {projectId:string;profileId:string;role:KanbanHarnessRole;code?:string}
export async function recordHarnessPreparation(journal:KanbanAutomationJournal,id:string,projectId:string,profileId:string,role:KanbanHarnessRole,validate:()=>Promise<string>):Promise<string> {
    try{
        const profile=await validate();
        if(await journal.get(harnessPreparationKey(id)))
            await journal.update<HarnessPreparation>(harnessPreparationKey(id),()=>({projectId,profileId,role}));
        return profile;
    }catch(error){
        const code=safeCode(error,'KANBAN_HARNESS_UNAVAILABLE');
        if(harnessSelectionFailure(code))await journal.update<HarnessPreparation>(harnessPreparationKey(id),()=>({projectId,profileId,role,code}));
        throw error;
    }
}
const log=createModuleLogger('kanban-harness-settings');
export function kanbanHarnessSettings(remote:ProjectRemoteMountService){
    const catalog=async(board:Pick<KanbanBoard,'settings'>):Promise<KanbanBoardSettingsCatalog>=>{
        const profiles=await availableProfiles(remote);
        return {description:t('kanban.harnessSettingsHelp'),fields:harnessRoles.map(role=>{
            const value=board.settings?.[harnessSettingKey(role)];const choices=[{value:'',label:t('kanban.harnessDefault'),disabled:false},...profiles.values()];
            if(value && !profiles.has(value))choices.push({value,label:value+' · '+t('kanban.harnessUnavailable'),disabled:true});
            return {name:harnessSettingKey(role),label:t(('kanban.harnessRole.'+role) as Parameters<typeof t>[0]),choices};
        })};
    };
    const modelsForDefaults=(profileId:string)=>availableModels(remote,profileId);
    return {catalog,modelsForDefaults,models:(projectId:string,profileId:string)=>projectHarnessModels(remote,projectId,profileId),validate:async(board:Pick<KanbanBoard,'settings'>,settings:Record<string,string>)=>{
        requireValue(Object.keys(settings).every(key=>harnessRoles.some(role=>harnessSettingKey(role)===key||harnessSelectionKey(role)===key)),'KANBAN_SETTINGS_UNKNOWN_FIELD');
        const view=await catalog(board);
        for(const field of view.fields){const value=settings[field.name]??'';
            requireValue(!value || value===board.settings?.[field.name] || field.choices.some(choice=>choice.value===value&&!choice.disabled),'KANBAN_HARNESS_UNAVAILABLE');}
        await validateDefaultModels(board.settings,settings,modelsForDefaults);
    }};
}
async function validateDefaultModels(previous:Record<string,string>|undefined,settings:Record<string,string>,models:(profile:string)=>Promise<KanbanHarnessModel[]>):Promise<void> {
    const reads=new Map<string,Promise<KanbanHarnessModel[]>>();
    const choices=harnessRoles.flatMap(role=>{
        const key=harnessSelectionKey(role),raw=settings[key];
        if(!raw||raw===previous?.[key]&&settings[harnessSettingKey(role)]===previous?.[harnessSettingKey(role)])return [];
        const choice=readHarnessChoice(role,settings);
        if(raw===previous?.[key]&&!choice?.selection)return [];
        requireValue(choice?.selection,'DECISION_HARNESS_SELECTION_INVALID');
        return [{profileId:choice.profileId,selection:choice.selection}];
    });
    const checked=await Promise.allSettled(choices.map(async choice=>{
        const pending=reads.get(choice.profileId)??models(choice.profileId);
        reads.set(choice.profileId,pending);
        requireAvailableSelection(await pending,choice.selection);
    }));
    const failure=checked.find(choice=>choice.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
}
async function availableProfiles(remote:ProjectRemoteMountService){
    const operationId=randomUUID(),started=Date.now(),scope=operationScope({timeoutMs:3000});
    const profiles=new Map<string,{value:string;label:string;disabled:boolean}>();
    try{await mapConcurrent(harnessProjects(remote),4,async projectId=>{
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

function harnessProjects(remote:ProjectRemoteMountService):string[] {
    const projects=new Map<string,string>();
    for(const id of remote.mountedProjectIds()){
        const root=remote.list(id).find(mount=>mount.at==='/');if(!root?.connectionId)continue;
        if(!projects.has(root.connectionId)||root.capabilities?.sessionControl===true)projects.set(root.connectionId,id);
    }
    return [...projects.values()];
}

async function availableModels(remote:ProjectRemoteMountService,profileId:string):Promise<KanbanHarnessModel[]> {
    requireValue(typeof profileId==='string'&&/^[\w-]{1,128}$/.test(profileId),'DECISION_HARNESS_SELECTION_INVALID');
    const scope=operationScope({timeoutMs:4000}), operationId=randomUUID(), started=Date.now(), stage='defaults.models';
    const failures:unknown[]=[];
    try{
        const results=await mapConcurrent(harnessProjects(remote),4,async projectId=>{
            const measured=Date.now();
            let client:Awaited<ReturnType<ProjectRemoteMountService['projectHarness']>>|undefined;
            try {
                checkOperation(scope.options);client=await remote.projectHarness(projectId,scope.options);
                const {profiles}=await client.profiles(scope.options);
                const profile=profiles.find(profile=>profile.id===profileId&&eligible(profile)&&profile.projectCapabilities?.sessionControl!==false);
                if(profile)return await harnessModels(client,profile,scope.options);
            } catch(error) {
                failures.push(error);
                log.warn('kanban.settings.models',{operationId,stage,projectId,result:'failure',code:safeCode(error,'KANBAN_HARNESS_MODEL_UNAVAILABLE'),durationMs:Date.now()-measured});
            } finally {await client?.close();}
        });
        const catalogs=results.filter(catalog=>catalog!==undefined);
        if(!catalogs.length&&failures.length)throw failures[0];
        const models=catalogs.reduce(intersectModels,catalogs[0]??[]);
        log.info('kanban.settings.models',{operationId,stage,result:'success',count:models.length,durationMs:Date.now()-started});
        return models;
    }finally{scope.dispose();}
}

function intersectModels(left:KanbanHarnessModel[],right:KanbanHarnessModel[]):KanbanHarnessModel[] {
    const byId=new Map(right.map(model=>[model.id,model]));
    return left.flatMap(model=>{
        const match=byId.get(model.id);
        return match?[{...model,reasoningEfforts:model.reasoningEfforts.filter(effort=>match.reasoningEfforts.some(level=>level.id===effort.id))}]:[];
    });
}

function eligible(profile:HarnessProfile):boolean{
    return !!profile.projectRuntime && profile.capabilities.create && !!profile.capabilities.sessionChannels && !!profile.capabilities.workingDirectory;
}
export function selectKanbanHarness(profiles:HarnessProfile[],workspaceId:string,selected?:string):HarnessProfile{
    const profile=selected?profiles.find(p=>p.id===selected || p.aliases?.includes(selected)):profiles.find(p=>eligible(p)&&p.workspaces.some(w=>w.id===workspaceId));
    requireValue(profile,'KANBAN_HARNESS_UNAVAILABLE');requireValue(profile.workspaces.some(w=>w.id===workspaceId),'KANBAN_HARNESS_WORKSPACE_MISMATCH');requireValue(profile.projectCapabilities?.sessionControl!==false,'KANBAN_HARNESS_PERMISSION_REQUIRED');
    requireValue(eligible(profile),'KANBAN_HARNESS_CAPABILITIES_REQUIRED');return profile;
}
type HarnessBinding={boardId:string;role:KanbanHarnessRole;profileId:string;selection?:KanbanHarnessModelSelection|null};
export async function readFrozenHarness(journal:KanbanAutomationJournal,id:string,legacySelection?:KanbanHarnessModelSelection):Promise<HarnessChoice|undefined> {
    const binding=await journal.get<HarnessBinding>('kanban-harness-choice:'+id);
    if(binding)return {profileId:binding.profileId,selection:binding.selection===undefined?legacySelection:binding.selection??undefined};
}
export async function freezeKanbanHarness(journal:KanbanAutomationJournal,id:string,boardId:string,role:KanbanHarnessRole,choice:HarnessChoice):Promise<HarnessChoice>{
    const binding=await journal.update<HarnessBinding>('kanban-harness-choice:'+id,old=>old??{boardId,role,profileId:choice.profileId,selection:choice.selection??null});
    requireValue(binding.boardId===boardId && binding.role===role,'KANBAN_HARNESS_BINDING_CHANGED');
    return {profileId:binding.profileId,selection:binding.selection===undefined?choice.selection:binding.selection??undefined};
}
