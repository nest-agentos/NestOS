import {sha256HexSync} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
import type {KanbanItemOperations,KanbanItemOperationRequest,KanbanItemOperationBinding} from '@nestos/kanban/contracts';
import type {ReviewOperationsOptions} from './item-operation-types';
import {requireValue} from './validation';
import {automaticDeliveryStatus} from './automatic-delivery';

export async function scopedOperationOptions(options:ReviewOperationsOptions,board:string,item:string,scopeId?:string):Promise<ReviewOperationsOptions> {
    if(!scopeId)return options;
    requireValue(options.scopes&&/^[\w-]{1,128}$/.test(scopeId),'OPERATION_SCOPE_INVALID');
    const resolved=await options.scopes.resolve(board,item,scopeId);
    return {...options,...resolved,scopeId,scopes:undefined};
}
/** A repository operation remains owned by the real management task; no synthetic Task is created. */
export async function readOperationScopes(options:ReviewOperationsOptions,board:string,item:string,read:(options:ReviewOperationsOptions)=>Promise<KanbanItemOperations>):Promise<KanbanItemOperations> {
    const route=await options.scopes?.describe(board,item);
    if(route?.owner)return {...await read(options),owner:route.owner};
    if(!route?.scopes)return read(options);
    const scopes=await Promise.all(route.scopes.map(async scope=>{
        const started=Date.now();
        try{return {...scope,view:await read(await scopedOperationOptions(options,board,item,scope.id))};}
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
    if(!route?.scopes)return automaticDeliveryStatus(options.journal,board,item);
    const statuses=await Promise.all(route.scopes.map(async scope=>scope.completed?{state:'completed' as const,stage:'completed'}:
        await automaticDeliveryStatus(options.journal,board,item,scope.id)??{state:'waiting-confirmation' as const,stage:'analyze'}));
    return statuses.find(row=>row.state==='blocked')??statuses.find(row=>row.state==='waiting-confirmation')
        ??statuses.find(row=>row.state==='running')??await automaticDeliveryStatus(options.journal,board,item)??(statuses.length?{state:'completed',stage:'completed'}:undefined);
}
