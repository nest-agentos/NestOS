import {randomUUID,createModuleLogger} from '@nestos/common';
import {journalCommand,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {GitProcess} from '@nestos/git-delivery/contracts';
import {processWorkspacePath} from '@nestos/git-delivery/paths';
import {reportTransferScript} from './report-transfer-script';
import {requireValue} from './validation';
const log=createModuleLogger('kanban');
interface Receipt {fingerprint:string;resourceId:string;owner:{boardId:string;itemId:string};path:string;sha256:string;bytes:number;files:Array<{path:string;bytes:number;sha256:string}>;existing?:boolean;fileCount?:number}
interface Intent {phase:'packing'|'delivered';owner:string;receipt?:Receipt}
export async function deliverSoftwareReports(options:{journal:KanbanAutomationJournal;service:KanbanService;process:GitProcess;directory:string;resourceId:string;owner:{boardId:string;itemId:string};budget?:{maxFiles:number;maxBytes:number}}):Promise<string|undefined> {
    const started=Date.now(),operationId=options.resourceId;
    requireValue(/^[\w-]{1,128}$/.test(operationId),'WORKTREE_SCOPE_INVALID');
    const target='/workspace/_nestos/kanban/deliveries/'+operationId;
    const config={source:await processWorkspacePath(options.process,options.directory),target:await processWorkspacePath(options.process,target),resourceId:operationId,owner:options.owner,maxFiles:options.budget?.maxFiles??2000,maxBytes:options.budget?.maxBytes??256*1024*1024};
    try{let receipt=await transfer(options.process,{...config,mode:'inspect'});if(receipt.fileCount===0)return;const key='software-report-delivery:'+operationId+':'+receipt.fingerprint;
        const claim=randomUUID(),saved=await options.journal.update<Intent>(key,old=>old??{phase:'packing',owner:claim});
        if(!receipt.existing)receipt=await transfer(options.process,{...config,mode:saved.owner===claim?'pack':'verify',fingerprint:receipt.fingerprint});
        requireValue(receipt.resourceId===operationId&&receipt.owner?.boardId===options.owner.boardId&&receipt.owner?.itemId===options.owner.itemId&&/^[a-f0-9]{64}$/.test(receipt.sha256),'SOFTWARE_REPORT_PACKAGE_INVALID');
        const path=target+'/'+receipt.fingerprint+'.tar.gz';
        await journalCommand(options.journal,options.service,options.owner.boardId,key+':owner',{type:'link-reference',itemId:options.owner.itemId,reference:{system:'nestos-software-reports',id:operationId,revision:JSON.stringify({path,sha256:receipt.sha256,bytes:receipt.bytes,files:receipt.files.length})}});
        await options.journal.update<Intent>(key,old=>({...old!,phase:'delivered',receipt:{...receipt,path}}));
        log.info('Reports handed to management',{operation:'software.delivery.reports',operationId,stage:'handoff',result:'success',count:receipt.files.length,bytes:receipt.bytes,durationMs:Date.now()-started});return path;
    }catch(error){log.warn('Report handoff incomplete',{operation:'software.delivery.reports',operationId,stage:'handoff',result:'failure',code:(error as {code?:string}).code??'SOFTWARE_REPORT_TRANSFER_FAILED',durationMs:Date.now()-started});throw error;}
}
async function transfer(process:GitProcess,config:Record<string,unknown>):Promise<Receipt> {
    const result=await process.nativeShell.exec('python3',['-c',reportTransferScript,JSON.stringify(config)],{cwd:'/workspace',timeoutMs:120000});
    let value:Receipt&{code?:string};try{value=JSON.parse(result.stdout);}catch{throw Object.assign(Error('Report receipt unavailable'),{code:'SOFTWARE_REPORT_HANDOFF_UNCONFIRMED'});}
    requireValue(result.code===0&&!!value.fingerprint,value.code??'SOFTWARE_REPORT_TRANSFER_FAILED');return value;
}
/** The entire owned, merged workspace is disposable after verified report handoff. */
export const disposableSoftwareFiles=(paths:readonly string[])=>[...paths];
