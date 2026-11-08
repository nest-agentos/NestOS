import {sha256Hex} from '@nestos/common';
import type {CellsDescriptor} from '@nestos/cells-driver';
import type {RemoteFileSystemConfig,RemoteFileSystemInput} from './remote-connections';

/** Short-lived private evidence; neither secrets nor verification handles enter the UI catalog. */
export class CellsDraftChecks {
    private readonly proofs=new Map<string,{at:number;descriptor?:CellsDescriptor}>();
    async key(input:RemoteFileSystemInput,password:string,id?:string,current?:RemoteFileSystemConfig):Promise<string> {
        const bytes=new TextEncoder().encode(JSON.stringify([id,input.endpoint,input.username,!!input.anonymous,password,
            current?.credentialRef,current?.endpoint,current?.username,current?.anonymous,current?.authorization]));
        return sha256Hex(bytes.buffer);
    }
    remember(key:string,descriptor?:CellsDescriptor):void {
        this.prune();this.proofs.set(key,{at:Date.now(),descriptor});
        while(this.proofs.size>32)this.proofs.delete(this.proofs.keys().next().value!);
    }
    read(key:string):{descriptor?:CellsDescriptor}|undefined {this.prune();return this.proofs.get(key);}
    clear():void{this.proofs.clear();}
    private prune():void{for(const [key,value] of this.proofs)if(Date.now()-value.at>5*60_000)this.proofs.delete(key);}
}
