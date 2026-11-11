import {proveCompatibleGitDelivery} from '@nestos/git-delivery/runtime';
import type {GitProcess} from '@nestos/git-delivery/contracts';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
/** The application selects an approved policy; Git provenance remains in the domain module. */
export function compatibleRuntimeDelivery(process:GitProcess,record:DevelopmentWorkspaceRecord,proof:Parameters<typeof proveCompatibleGitDelivery>[2],previousVersion:string) {
    const choice=(record.context as {decision?:{snapshot?:{verificationLevel?:string;deliveryMode?:string}}})?.decision?.snapshot;
    if(choice?.verificationLevel!=='none'||choice.deliveryMode!=='release')return Promise.resolve(undefined);
    return proveCompatibleGitDelivery(process,record,proof,previousVersion);
}
