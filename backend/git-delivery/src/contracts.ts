import type {INativeShell} from '@nestos/tools';
export interface GitProcess {nativeShell:Pick<INativeShell,'exec'>}
export interface GitJournal {get<T>(key:string):Promise<T|undefined>;update<T>(key:string,change:(old:T|undefined)=>T):Promise<T>}
export interface GitApproval {selections?:Record<string,string>;plan?:{conflicts?:Array<{id:string;path:string;options:Array<{id:string}>}>}}
export interface GitSource {sourceHead?:string;directory:string;repositories?:Array<{path:string;head:string;dirty?:boolean}>}
export interface GitIntegration {incompleteCode?:'OPERATION_RESULT_BATCH_INCOMPLETE'|'OPERATION_RESULT_MERGE_UNCONFIRMED';previousTarget:string;actualTarget:string;reportedTarget?:string;sources:GitSource[];approval?:GitApproval}
export interface MergePlan {
    sourceVersion:string;targetVersion:string;summary:string;
    conflicts:Array<{id:string;path:string;reason:string;options:Array<{id:string;label:string;detail?:string}>}>;
}
export interface GitOperationReceiptScope {
    id:string;action:'build'|'deploy'|'accept'|'analyze'|'merge';requireStatus:boolean;expectedVersion?:string;
    snapshot:{sourceVersion:string;targetVersion:string};
}
