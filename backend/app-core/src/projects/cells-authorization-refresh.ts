import {randomUUID} from '@nestos/common';
import {checkOperation,FSError,type OperationOptions} from '@nestos/vfs-core';
import type {CellsDescriptor} from '@nestos/cells-driver';
import type {CellsAuthorizationRefresh} from '@nestos/app-contracts/services';
import type {RemoteFileSystemConfig} from './remote-connections';

type Discover=(connection:RemoteFileSystemConfig,options?:OperationOptions)=>Promise<CellsDescriptor>;
type Candidate={baseline:string;view:CellsAuthorizationRefresh;expiresAt:number};
const fingerprint=(value:RemoteFileSystemConfig)=>JSON.stringify(value);

/** Discovery is read-only. Only an explicit, revalidated proposal can be committed. */
export class CellsAuthorizationRefreshes {
    private readonly candidates=new Map<string,Candidate>();
    private readonly pending=new Map<string,{baseline:string;work:Promise<void>}>();
    private closed=false;
    read(connection:RemoteFileSystemConfig):CellsAuthorizationRefresh|undefined {
        const candidate=this.candidates.get(connection.id);
        if(!candidate||candidate.expiresAt<=Date.now()||candidate.baseline!==fingerprint(connection))return;
        return structuredClone(candidate.view);
    }
    inspect(connection:RemoteFileSystemConfig,discover:Discover,projects:string[],options?:OperationOptions):Promise<void> {
        if(this.closed)return Promise.resolve();
        if(this.read(connection))return Promise.resolve();
        const baseline=fingerprint(connection),existing=this.pending.get(connection.id);
        if(existing?.baseline===baseline)return existing.work;
        const work=this.probe(connection,discover,projects,options).finally(()=>{
            if(this.pending.get(connection.id)?.work===work)this.pending.delete(connection.id);
        });
        this.pending.set(connection.id,{baseline,work});return work;
    }
    private async probe(connection:RemoteFileSystemConfig,discover:Discover,projects:string[],options?:OperationOptions):Promise<void> {
        let descriptor:CellsDescriptor|undefined,view:CellsAuthorizationRefresh;
        try {
            descriptor=await discover({...connection,authorization:undefined},options);checkOperation(options);
            const reason=identityMismatch(connection,descriptor);
            view=reason?{state:'blocked',reason}:connection.authorization!.revision===descriptor.authorization!.revision?{state:'unchanged'}:{
                state:'available',proposalId:randomUUID(),serverId:descriptor.serverId!,principalId:descriptor.authorization!.principalId,
                previousRevision:connection.authorization!.revision,nextRevision:descriptor.authorization!.revision,
                detectedAt:Date.now(),expiresAt:Date.now()+5*60_000,affectedProjectIds:[...projects]};
        }catch(error){
            checkOperation(options);
            const code=(error as {code?:unknown})?.code;
            view={state:'unavailable',code:typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'CELLS_DISCOVERY_FAILED'};
        }
        if(this.closed)return;
        this.candidates.set(connection.id,{baseline:fingerprint(connection),view,
            expiresAt:view.state==='available'?view.expiresAt:Date.now()+15_000});
        while(this.candidates.size>32)this.candidates.delete(this.candidates.keys().next().value!);
    }
    async verify(connection:RemoteFileSystemConfig,proposalId:string,discover:Discover,options?:OperationOptions):Promise<CellsDescriptor> {
        const view=this.read(connection);
        if(view?.state!=='available'||view.proposalId!==proposalId)throw refreshError('ECONFLICT','CELLS_AUTHORIZATION_REFRESH_EXPIRED');
        const fresh=await discover({...connection,authorization:undefined},options);checkOperation(options);
        if(Date.now()>=view.expiresAt)throw refreshError('ECONFLICT','CELLS_AUTHORIZATION_REFRESH_EXPIRED');
        if(identityMismatch(connection,fresh)) {
            this.clear(connection.id);throw refreshError('EACCES','CELLS_AUTHORIZATION_IDENTITY_CHANGED');
        }
        if(fresh.authorization!.revision!==view.nextRevision) {
            this.clear(connection.id);throw refreshError('ECONFLICT','CELLS_AUTHORIZATION_REFRESH_CHANGED');
        }
        return fresh;
    }
    failed(connection:RemoteFileSystemConfig,code:string):void {
        if(this.closed)return;
        this.candidates.set(connection.id,{baseline:fingerprint(connection),view:{state:'unavailable',code},expiresAt:Date.now()+15_000});
        while(this.candidates.size>32)this.candidates.delete(this.candidates.keys().next().value!);
    }
    clear(id:string):void{this.candidates.delete(id);}
    async dispose():Promise<void>{this.closed=true;await Promise.allSettled([...this.pending.values()].map(value=>value.work));this.candidates.clear();}
}
function identityMismatch(before:RemoteFileSystemConfig,after:CellsDescriptor):Extract<CellsAuthorizationRefresh,{state:'blocked'}>['reason']|undefined {
    if(!before.serverId||!before.authorization||!after.serverId||!after.authorization||before.anonymous||after.authorization.anonymous)return 'identity-unverified';
    if(before.serverId!==after.serverId)return 'server-changed';
    if(before.authorization.principalId!==after.authorization.principalId||before.authorization.anonymous!==after.authorization.anonymous)return 'principal-changed';
    if(new URL(before.endpoint).origin!==new URL(after.httpEndpoint).origin)return 'server-changed';
}

function refreshError(code:'ECONFLICT'|'EACCES',reason:string):FSError {
    return Object.assign(new FSError(code,reason),{remoteCode:reason});
}
