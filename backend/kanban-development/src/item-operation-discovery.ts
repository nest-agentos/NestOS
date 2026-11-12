import {kanbanTaskType} from '@nestos/kanban/contracts';
import {safeCode} from '@nestos/kanban/integration';
import type {ReviewOperationsOptions} from './item-operation-types';
import {scopedOperationOptions} from './item-operation-scopes';
type Registered={board:string;item:string;scopeId?:string};

/** Discover ready management scopes in the background; opening a view never starts work. */
export async function discoverOperationScopes(options:ReviewOperationsOptions,registered:Registered[],active:()=>boolean,scan:(options:ReviewOperationsOptions,board:string,item:string)=>Promise<void>):Promise<void> {
    if(!options.scopes||!options.automatic||!active())return;
    const known=new Set(registered.map(row=>JSON.stringify([row.board,row.item,row.scopeId])));
    for(const entry of await options.service.catalog()){
        if(!active())return;
        const board=await options.service.read(entry.id);
        if(!board.automation?.enabled||board.executionControl?.paused||board.lifecycle)continue;
        for(const item of board.items){
            if(!active())return;
            if(item.deletedAt||item.status==='cancelled'||item.control?.action==='cancel'||kanbanTaskType(item)!=='coordination'||!await options.automatic(board,item))continue;
            const started=Date.now();
            try{
                const route=await options.scopes.describe(board.id,item.id);
                for(const scope of route?.scopes??[]){
                    if(!active())return;
                    if(scope.completed||scope.ready===false||known.has(JSON.stringify([board.id,item.id,scope.id])))continue;
                    await scan(await scopedOperationOptions(options,board.id,item.id,scope.id),board.id,item.id);
                }
            }catch(error){options.log({operationId:item.id,stage:'operation.scope.discover',result:'failure',code:safeCode(error,'OPERATION_SCOPE_UNAVAILABLE'),durationMs:Date.now()-started});}
        }
    }
}
