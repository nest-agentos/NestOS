import {repositoryDeliveryPlan} from '@nestos/git-delivery/policy';
import {sha256HexSync,t} from '@nestos/common';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import type {OperationScopeProvider,ReviewAdapter,ReviewJob,ReviewOperationsOptions,DeliveryPlan,ReviewSettings} from '../kanban/item-operation-types';
import {reviewKey,jobKey} from '../kanban/item-operation-types';
import {requireValue} from '../kanban/validation';
import {managementReviewAdapter} from './kanban-management-review';
import type {DevelopmentReviewOptions} from './kanban-development-review';
import {requiresDevelopmentProject} from './kanban-development-policy';
import {managementBatch} from './kanban-management-snapshot';
import {managementTaskOwner as managementOwner} from '@nestos/kanban/integration';
import {managementScopes,savedManagementScopes,managementScopeKey,integratedContributionKey,isManagementVerifier,type ManagementScope} from './kanban-management-scope-catalog';

interface Options extends DevelopmentReviewOptions {
    basePlan:NonNullable<ReviewOperationsOptions['deliveryPlan']>;
    cleanup?:ReviewOperationsOptions['cleanup'];
}
export function managementOperationScopes(options:Options) {return new ManagementOperations(options);}
class ManagementOperations implements OperationScopeProvider {
    private readonly adapters=new Map<string,ReviewAdapter>();
    constructor(private readonly options:Options) {}
    private projectLabel=async(id:string)=>(await this.options.projects.get(id)).name;
    private repositoryKey=(id:string)=>{const root=this.options.remote.list(id).find(mount=>mount.at==='/');return root?.serverId&&root.serverProjectId?JSON.stringify([root.serverId,root.serverProjectId]):id;};
    describe=async(boardId:string,itemId:string)=>{
        const board=await this.options.service.read(boardId),item=(await this.options.service.item(boardId,itemId)).item;
        if(!requiresDevelopmentProject(board)||isManagementVerifier(item))return;
        const owner=managementOwner(board,item);if(!owner)return;
        if(owner.id!==item.id)return {owner:{boardId,itemId:owner.id},permittedActions:['accept','cancel']};
        return {scopes:(await managementScopes({...this.options,projectLabel:this.projectLabel,repositoryKey:this.repositoryKey},board,owner)).map(scope=>({...scope,completed:scope.stage==='cleaned'}))};
    };
    deliveryPlan=async(board:KanbanBoard,item:KanbanItem):Promise<DeliveryPlan>=>{
        const base=await this.options.basePlan(board,item),owner=requiresDevelopmentProject(board)?managementOwner(board,item):undefined;
        return owner&&owner.id!==item.id&&!isManagementVerifier(item)?{steps:['accept'],acceptance:'source',acceptanceLabel:t('kanban.operationHandoff'),acceptanceConfirmation:t('kanban.operationConfirmHandoff')}:base;
    };
    handoff=async(board:KanbanBoard,item:KanbanItem)=>{
        const owner=requiresDevelopmentProject(board)?managementOwner(board,item):undefined;
        return owner&&owner.id!==item.id&&!isManagementVerifier(item)?{boardId:board.id,itemId:owner.id}:undefined;
    };
    dependencyReady=async(board:string,item:KanbanItem)=>{
        const route=await this.describe(board,item.id);
        if(route?.scopes&&!route.scopes.length)return false;
        if(route?.scopes?.some(scope=>!scope.completed))return false;
        if(!route?.owner)return;
        if(item.status!=='completed')return false;
        const original=await this.options.basePlan(await this.options.service.read(board),item);
        if(!original.steps.includes('deploy'))return true;
        return hasManagementReceipt(this.options,route.owner,item.id,'deploy');
    };
    close=async()=>{await Promise.all([...this.adapters.values()].map(adapter=>adapter.close?.()));this.adapters.clear();};
    resolve=async(board:string,item:string,id:string):Promise<Partial<ReviewOperationsOptions>>=>{
        const saved=await this.options.journal.get<ManagementScope>(managementScopeKey(id)),route=await this.describe(board,item);
        const scope=saved??route?.scopes?.find(row=>row.id===id);
        requireValue(scope&&scope.boardId===board&&scope.ownerId===item,'OPERATION_SCOPE_INVALID');
        let adapter=this.adapters.get(id);
        if(!adapter){const base=managementReviewAdapter(this.options,scope);
            adapter={...base,snapshot:async(definition,owner)=>{await requireUpstreamIntegration(this.options,scope,definition);return base.snapshot(definition,owner);}};
            this.adapters.set(id,adapter);}
        return {adapter,deliveryPlan:definition=>repositoryPlan(this.options,scope,definition),automaticTarget:()=>scope.projectId,
            cleanup:(_board,_item,operationId)=>cleanupManagementScope(this.options,scope,operationId)};
    };
    report=async(job:ReviewJob):Promise<void>=>{
        if(!job.scopeId||job.phase!=='settled'||job.state!=='succeeded'||!['merge','accept'].includes(job.action))return;
        const scope=await this.options.journal.get<ManagementScope>(managementScopeKey(job.scopeId));requireValue(scope&&scope.ownerId===job.itemId&&scope.boardId===job.boardId,'OPERATION_SCOPE_MISMATCH');
        await this.options.journal.update<ManagementScope>(managementScopeKey(scope.id),old=>old?.stage==='cleaned'||old?.stage==='accepted'&&job.action==='merge'?old:{...old!,stage:job.action==='merge'?'merged':'accepted'});
        if(job.action!=='merge')return;
        for(const source of managementBatch(job.snapshot).sources)await this.options.journal.update(integratedContributionKey(job.boardId,job.itemId,source.dispatchId),old=>old??{operationId:job.id,scopeId:scope.id,sourceVersion:source.snapshot.sourceVersion,targetHead:(job.result as {targetHead:string}).targetHead});
    };
}
async function cleanupManagementScope(options:Options,scope:ManagementScope,operationId:string):Promise<boolean> {
    if(!options.cleanup)return false;
    for(const source of scope.contributors)if(!await options.cleanup(scope.boardId,source.itemId,'management-cleanup-'+sha256HexSync(JSON.stringify([operationId,source.itemId])).slice(0,40)))return false;
    await options.journal.update<ManagementScope>(managementScopeKey(scope.id),old=>({...old!,stage:'cleaned'}));return true;
}

async function repositoryPlan(options:Options,scope:ManagementScope,board:KanbanBoard):Promise<DeliveryPlan> {
    const plans=await Promise.all(scope.contributors.map(async source=>options.basePlan(board,(await options.service.item(board.id,source.itemId)).item)));
    return repositoryDeliveryPlan(plans);
}
async function hasManagementReceipt(options:Options,owner:{boardId:string;itemId:string},source:string,action:string):Promise<boolean> {
    for(const scope of await savedManagementScopes(options.journal,owner.boardId,owner.itemId)){
        const latest=Object.values((await options.service.workflow(owner.boardId)).dispatches).filter(row=>row.itemId===source).sort((a,b)=>b.attempt-a.attempt)[0];
        if(!scope.contributors.some(row=>row.itemId===source&&row.dispatchId===latest?.id))continue;
        const settings=await options.journal.get<ReviewSettings>(reviewKey(owner.boardId,owner.itemId,scope.id));
        const jobs=await options.journal.getMany<ReviewJob>(settings?.jobs.map(jobKey)??[]);
        if(jobs.some(job=>job?.action===action&&job.phase==='settled'&&job.state==='succeeded'))return true;
    }
    return false;
}

async function requireUpstreamIntegration(options:Options,scope:ManagementScope,board:KanbanBoard):Promise<void> {
    const ids=new Set(scope.contributors.map(source=>source.itemId));
    const workflow=await options.service.workflow(board.id);
    for(const source of scope.contributors){
        const item=(await options.service.item(board.id,source.itemId)).item;
        for(const dependency of item.planning?.dependencies??[]){
            if(ids.has(dependency))continue;
            const other=(await options.service.item(board.id,dependency)).item;
            if(managementOwner(board,other)?.id!==scope.ownerId||isManagementVerifier(other))continue;
            const latest=Object.values(workflow.dispatches).filter(row=>row.itemId===dependency).sort((a,b)=>b.attempt-a.attempt)[0];
            requireValue(latest&&await options.journal.get(integratedContributionKey(board.id,scope.ownerId,latest.id)),'OPERATION_UPSTREAM_INTEGRATION_REQUIRED');
        }
    }
}
