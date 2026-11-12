import {developmentDeliveryPolicy} from './development-operation-policy';
import {sha256HexSync,t} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
import type {KanbanItemOperations,KanbanItemOperationRequest,KanbanItemOperationBinding} from '@nestos/kanban/contracts';
import type {ReviewOperationsOptions} from './item-operation-types';
import {requireValue} from './validation';
import {automaticDeliveryStatus} from '@nestos/kanban/integration';

export async function scopedOperationOptions(options:ReviewOperationsOptions,board:string,item:string,scopeId?:string):Promise<ReviewOperationsOptions> {
    if(!scopeId)return options;
    requireValue(options.scopes&&/^[\w-]{1,128}$/.test(scopeId),'OPERATION_SCOPE_INVALID');
    const resolved=await options.scopes.resolve(board,item,scopeId);
    return {...options,...resolved,scopeId,scopes:undefined};
}
/** A repository operation remains owned by the real management task; no synthetic Task is created. */
export async function readOperationScopes(options:ReviewOperationsOptions,board:string,item:string,read:(options:ReviewOperationsOptions)=>Promise<KanbanItemOperations>):Promise<KanbanItemOperations> {
    const route=await options.scopes?.describe(board,item);
    if(route?.owner)return handoffProjection(await read(options),route.owner);
    if(!route?.scopes)return read(options);
    const scopes=await Promise.all(route.scopes.map(async scope=>{
        const started=Date.now();
        try{
            const view=await read(await scopedOperationOptions(options,board,item,scope.id));
            return {...scope,view:scope.completed?{...view,automatic:{state:'completed' as const,stage:'completed'},
                operations:view.operations.map(operation=>({...operation,enabled:false}))}:view};
        }
        catch(error){const code=safeCode(error,'OPERATION_SCOPE_UNAVAILABLE');options.log({operationId:scope.id,stage:'operation.scope.read',result:'failure',code,durationMs:Date.now()-started});
            return {...scope,view:{revision:sha256HexSync(JSON.stringify([scope.id,code])),operations:[],code}};}
    }));
    return {revision:sha256HexSync(JSON.stringify(scopes.map(scope=>[scope.id,scope.view.revision]))),operations:[],scopes};
}
export async function operationRequestOptions(options:ReviewOperationsOptions,board:string,request:KanbanItemOperationRequest|KanbanItemOperationBinding):Promise<ReviewOperationsOptions> {
    if(request.scopeId)return scopedOperationOptions(options,board,request.itemId,request.scopeId);
    const route=await options.scopes?.describe(board,request.itemId);
    requireValue(!route?.owner&&!route?.scopes||route?.permittedActions?.includes(request.action),'OPERATION_SCOPE_REQUIRED');
    return options;
}

/** Project finalization facts without opening any Session or advancing an operation. */
export async function scopedFinalizationStatus(options:ReviewOperationsOptions,board:string,item:string):Promise<KanbanItemOperations['automatic']> {
    const route=await options.scopes?.describe(board,item);
    if(!route?.scopes?.length)return automaticDeliveryStatus(options.journal,board,item,undefined,developmentDeliveryPolicy.steps);
    const statuses=await Promise.all(route.scopes.map(async scope=>scope.completed?{state:'completed' as const,stage:'completed'}:
        await automaticDeliveryStatus(options.journal,board,item,scope.id,developmentDeliveryPolicy.steps)??{state:'running' as const,stage:scope.ready===false?'waiting-dependency':'analyze'}));
    return statuses.find(row=>row.state==='blocked')??statuses.find(row=>row.state==='waiting-confirmation')
        ??statuses.find(row=>row.state==='running')??{state:'completed',stage:'completed'};
}

/** Normal source handoff is a host receipt, not a user acceptance step. */
function handoffProjection(view:KanbanItemOperations,owner:NonNullable<KanbanItemOperations['owner']>):KanbanItemOperations {
    const operations=view.operations.filter(row=>['failed','unknown','cancelling','cancelled'].includes(row.state)||row.id!=='accept'&&row.runId&&row.state==='running').map(row=>row.id!=='accept'?row:{
        ...row,label:t('kanban.operationHandoff'),group:{id:'handoff',label:t('kanban.operationHandoff')},runLabel:t('kanban.operationRetryHandoff'),confirmation:undefined,skip:undefined});
    return {...view,owner,operations,code:view.code??(view.automatic?.state==='blocked'?view.automatic.code:undefined)};
}
