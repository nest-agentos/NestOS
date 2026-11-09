import {FSError} from '@nestos/vfs-core';
import {createModuleLogger} from '@nestos/common';
import {harnessObservation, projectNodeQueue, type HarnessNodeRecoveryResult} from '@nestos/cells-driver';
import type {NativeSessionRecoveryTarget, NativeSessionRecoveryRequest, NativeSessionRecoveryResult,
    NativeSessionRecoveryState} from '@nestos/app-contracts/services';
const log=createModuleLogger('session-recovery');
interface CellsRecoveryBackend {nativeSessionRecovery(target:NativeSessionRecoveryTarget,request?:NativeSessionRecoveryRequest):Promise<HarnessNodeRecoveryResult>}
/** Authorization and transport only. Cells owns recovery decisions and durable receipts. */
export class NativeSessionRecovery {
    private closed=false;
    private readonly admitted=new Set<Promise<unknown>>();
    constructor(private readonly remote: () => CellsRecoveryBackend | undefined) {}
    async inspect(target: NativeSessionRecoveryTarget): Promise<NativeSessionRecoveryState> {
        validateRecoveryTarget(target);return state(await this.forward(target));
    }
    async recover(input: NativeSessionRecoveryRequest): Promise<NativeSessionRecoveryResult> {
        const request=validateRecoveryRequest(input), started=Date.now();
        try {
            const result=await this.forward(request,request);
            if (!result.operationId || !result.outcome || typeof result.duplicate!=='boolean') throw new FSError('EIO','Cells recovery receipt is incomplete');
            log.info('session.recovery',{operationId:request.operationId,stage:'cells_forward',result:'success',durationMs:Date.now()-started});
            return {operationId:result.operationId,outcome:result.outcome,duplicate:result.duplicate,state:state(result)};
        } catch(error) {
            log.warn('session.recovery',{operationId:request.operationId,stage:'cells_forward',result:'failure',code:(error as {remoteCode?:string;code?:string})?.remoteCode??(error as {code?:string})?.code??'EIO',durationMs:Date.now()-started});throw error;
        }
    }
    private forward(target: NativeSessionRecoveryTarget, request?: NativeSessionRecoveryRequest): Promise<HarnessNodeRecoveryResult> {
        if(this.closed) return Promise.reject(new FSError('EBUSY','Session recovery is stopping'));
        const remote=this.remote();if(!remote?.nativeSessionRecovery) return Promise.reject(new FSError('ECAPABILITY','Cells recovery unavailable'));
        const operation=Promise.resolve().then(()=>remote.nativeSessionRecovery(target,request));
        this.admitted.add(operation);void operation.finally(()=>this.admitted.delete(operation)).catch(()=>{});return operation;
    }
    async close(): Promise<void> {this.closed=true;await Promise.allSettled([...this.admitted]);}
}
function state(result: HarnessNodeRecoveryResult): NativeSessionRecoveryState {
    const session=result.session, observation=harnessObservation(session);
    const active=['running','waiting-approval','waiting-input'].includes(observation.execution);
    return {sessionId:session.id,instructionQueue:projectNodeQueue(result.queue),observation,active,pending:false,disconnected:false,gap:false,
        canQueue:!session.archived,canSend:!active && session.owned===true && !result.queue?.items.length,canInterrupt:observation.canInterrupt,canRespond:observation.canRespond,
        writerLock:session.writerLock,executionRecovery:session.executionRecovery};
}
export function validateRecoveryTarget(target: NativeSessionRecoveryTarget): void {
    if (!target || ![target.projectId, target.profileId, target.sessionId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))
        throw new FSError('EINVAL', 'Invalid session recovery target');
}
function validateRecoveryRequest(input: NativeSessionRecoveryRequest): NativeSessionRecoveryRequest {
    validateRecoveryTarget(input);
    if (![input.operationId, input.instructionId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new FSError('EINVAL', 'Invalid session recovery request');
    const {projectId, profileId, sessionId, operationId, instructionId, expectedRevision} = input;
    return {projectId, profileId, sessionId, operationId, instructionId, expectedRevision};
}

