import {randomUUID,createModuleLogger} from '@nestos/common';
import {journalCommand,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {GitProcess} from '@nestos/git-delivery/contracts';
import {processWorkspacePath} from '@nestos/git-delivery/paths';
import {reportTransferScript} from './report-transfer-script';
import {requireValue} from './validation';
const log=createModuleLogger('kanban');
interface Receipt {fingerprint:string;resourceId:string;owner:{boardId:string;itemId:string};path?:string;sha256:string;bytes:number;existing?:boolean;fileCount:number}
interface Intent {phase:'packing'|'delivered'|'released';owner:string;receipt?:Receipt;releasedAt?:number}
const reportBudget={maxFiles:2000,maxBytes:256*1024*1024};
export async function inspectSoftwareReports(process:GitProcess,directory:string):Promise<import('@nestos/kanban/contracts').KanbanReportUsage>{
    const source=await processWorkspacePath(process,directory);
    const result=await process.nativeShell.exec('python3',['-c',reportTransferScript,JSON.stringify({...reportBudget,source,target:source,mode:'usage'})],{cwd:'/workspace',timeoutMs:120000});
    let value:import('@nestos/kanban/contracts').KanbanReportUsage&{code?:string};
    try{value=JSON.parse(result.stdout);}catch{throw Object.assign(Error('Report usage unavailable'),{code:'SOFTWARE_REPORT_HANDOFF_UNCONFIRMED'});}
    if(result.code!==0||!Number.isSafeInteger(value.files)||!Number.isSafeInteger(value.bytes)||!Array.isArray(value.directories))
        throw Object.assign(Error('Report usage unavailable'),{code:value.code??'SOFTWARE_REPORT_HANDOFF_UNCONFIRMED'});
    return value;
}
const reportKey='software-report-delivery:';
export async function deliverSoftwareReports(options:{journal:KanbanAutomationJournal;service:KanbanService;process:GitProcess;directory:string;resourceId:string;owner:{boardId:string;itemId:string};existingOnly?:boolean;budget?:{maxFiles:number;maxBytes:number}}):Promise<string|undefined> {
    const started=Date.now(),operationId=options.resourceId;
    requireValue(/^[\w-]{1,128}$/.test(operationId),'WORKTREE_SCOPE_INVALID');
    const target='/workspace/_nestos/kanban/deliveries/'+operationId;
    const config={source:await processWorkspacePath(options.process,options.directory),target:await processWorkspacePath(options.process,target),resourceId:operationId,owner:options.owner,maxFiles:options.budget?.maxFiles??reportBudget.maxFiles,maxBytes:options.budget?.maxBytes??reportBudget.maxBytes};
    try{let receipt=await transfer(options.process,{...config,mode:options.existingOnly?'reconcile':'inspect'});if(receipt.fileCount===0)return;const key=reportKey+operationId+':'+receipt.fingerprint;
        const claim=randomUUID(),saved=await options.journal.update<Intent>(key,old=>old??{phase:'packing',owner:claim});
        if(!receipt.existing)receipt=await transfer(options.process,{...config,mode:saved.owner===claim?'pack':'verify',fingerprint:receipt.fingerprint});
        requireValue(receipt.resourceId===operationId&&receipt.owner?.boardId===options.owner.boardId&&receipt.owner?.itemId===options.owner.itemId&&/^[a-f0-9]{64}$/.test(receipt.sha256)&&Number.isSafeInteger(receipt.fileCount)&&receipt.fileCount>0,'SOFTWARE_REPORT_PACKAGE_INVALID');
        const path=target+'/'+receipt.fingerprint+'.tar.gz';
        await journalCommand(options.journal,options.service,options.owner.boardId,key+':owner',{type:'link-reference',itemId:options.owner.itemId,reference:{system:'nestos-software-reports',id:operationId,revision:JSON.stringify({path,sha256:receipt.sha256,bytes:receipt.bytes,files:receipt.fileCount})}});
        await options.journal.update<Intent>(key,old=>({...old!,phase:'delivered',receipt:{...receipt,path}}));
        log.info('Reports handed to management',{operation:'software.delivery.reports',operationId,stage:'handoff',result:'success',count:receipt.fileCount,bytes:receipt.bytes,durationMs:Date.now()-started});return path;
    }catch(error){log.warn('Report handoff incomplete',{operation:'software.delivery.reports',operationId,stage:'handoff',result:'failure',code:(error as {code?:string}).code??'SOFTWARE_REPORT_TRANSFER_FAILED',durationMs:Date.now()-started});throw error;}
}
/** Retain the verification receipt and release the archive after the owning lifecycle settles. */
export async function releaseSoftwareReportPackages(options:{journal:KanbanAutomationJournal;ready(receipt:Receipt):Promise<boolean>;
    withProcess(receipt:Receipt,work:(process:GitProcess)=>Promise<void>):Promise<void>}):Promise<void> {
    const candidates=await options.journal.find<Intent>(reportKey,row=>row.phase==='delivered'&&!!row.receipt);
    let released=0;
    for(const {key,value} of candidates){
        const receipt=value.receipt!,operationId=receipt.resourceId,started=Date.now(),event={operation:'software.delivery.reports',operationId,stage:'release'};
        try {
            if(!await options.ready(receipt))continue;
            await options.withProcess(receipt,async process=>{
                requireValue(/^[\w-]{1,128}$/.test(operationId)&&/^[a-f0-9]{64}$/.test(receipt.fingerprint),'SOFTWARE_REPORT_PACKAGE_INVALID');
                const target=await processWorkspacePath(process,'/workspace/_nestos/kanban/deliveries/'+operationId);
                await transfer(process,{source:target,target,mode:'release',resourceId:operationId,owner:receipt.owner,fingerprint:receipt.fingerprint,sha256:receipt.sha256});
            });
            await options.journal.update<Intent>(key,old=>({...old!,phase:'released',releasedAt:old?.releasedAt??Date.now()}));
            log.info('Report package released',{...event,result:'success',bytes:receipt.bytes,durationMs:Date.now()-started});
            if(++released===8)break;
        }catch(error){log.warn('Report package release failed',{...event,result:'failure',code:(error as {code?:string}).code??'SOFTWARE_REPORT_RELEASE_FAILED',durationMs:Date.now()-started});}
    }
}
async function transfer(process:GitProcess,config:Record<string,unknown>):Promise<Receipt> {
    const result=await process.nativeShell.exec('python3',['-c',reportTransferScript,JSON.stringify(config)],{cwd:'/workspace',timeoutMs:120000});
    let value:Receipt&{code?:string;kind?:string};try{value=JSON.parse(result.stdout);}catch{throw Object.assign(Error('Report receipt unavailable'),{code:'SOFTWARE_REPORT_HANDOFF_UNCONFIRMED'});}
    if(result.code!==0||!value.fingerprint) {
        const code=value.code??'SOFTWARE_REPORT_TRANSFER_FAILED';
        const detail=code==='SOFTWARE_REPORT_TYPE_UNSUPPORTED'&&['symlink','special-file'].includes(value.kind??'')&&typeof value.path==='string'&&value.path.length<=1024&&!/[\u0000-\u001f\u007f]/u.test(value.path)
            ? '报告目录包含不支持的'+(value.kind==='symlink'?'符号链接':'特殊文件')+'：'+value.path+'。清理本任务临时条目后重试。':undefined;
        throw Object.assign(Error(code),{code,...(detail?{diagnostic:detail}:{})});
    }
    return value;
}
/** The entire owned, merged workspace is disposable after verified report handoff. */
export const disposableSoftwareFiles=(paths:readonly string[])=>[...paths];
