import type {ReviewOperationsOptions} from './item-operation-types';
/** Runtime identity belongs to the selected task target, not the application hosting the board. */
export async function operationRuntimeVersion(options:ReviewOperationsOptions,boardId:string,itemId:string):Promise<string|undefined> {
    if(!options.adapter.runtimeVersion)return options.adapter.runningVersion?.();
    const board=await options.service.read(boardId),{item}=await options.service.item(boardId,itemId);
    return options.adapter.runtimeVersion(board,item);
}
