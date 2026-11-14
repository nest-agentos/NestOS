import {randomUUID} from '@nestos/common';
import {FSError} from '@nestos/vfs-core';
import type {ApplicationBackend,ApplicationServices,StartupReadRequest,StartupReadResult,StartupReadSection} from '@nestos/app-contracts/services';
/** Compose only requested reads through their existing authorized domain ports. */
export async function readStartup(backend:ApplicationBackend,services:Pick<ApplicationServices,'kanban'>,request:StartupReadRequest):Promise<StartupReadResult> {
    validateRequest(request);
    const operationId=randomUUID();
    const eventBaseline=request.eventBaseline?await readSection(operationId,'events',()=>backend.events?backend.events.eventBaseline():unavailable()):undefined;
    const [documents,decision]=await Promise.all([
        request.documents?readSection(operationId,'documents',()=>backend.readUiDocuments(request.documents!)):undefined,
        request.decision?readSection(operationId,'decision',()=>services.kanban?.decisionSnapshot?services.kanban.decisionSnapshot(request.decision!.boardId,request.decision!.query):unavailable()):undefined,
    ]);
    return {request,eventBaseline,documents,decision};
}
function validateRequest(request:StartupReadRequest):void {
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['documents','eventBaseline','decision'].includes(key)))throw new FSError('EINVAL','Invalid startup read');
    if(request.eventBaseline!==undefined&&typeof request.eventBaseline!=='boolean')throw new FSError('EINVAL','Invalid event baseline request');
    validateDocuments(request.documents);validateDecision(request.decision);
}
function validateDocuments(documents:StartupReadRequest['documents']):void {
    if(documents!==undefined&&(!Array.isArray(documents)||documents.length>16||documents.some(name=>typeof name!=='string')))throw new FSError('EINVAL','Invalid startup documents');
}
function validateDecision(decision:StartupReadRequest['decision']):void {
    if(decision!==undefined&&(!decision||typeof decision.boardId!=='string'||!decision.boardId||!decision.query))throw new FSError('EINVAL','Invalid decision read');
}
async function readSection<T>(operationId:string,stage:string,read:()=>Promise<T>):Promise<StartupReadSection<T>> {
    const started=Date.now();
    try {
        const value=await read();
        console.info('[ApplicationRead]',{operation:'application.startup.read',operationId,stage,result:'success',durationMs:Date.now()-started});
        return {value};
    }catch(error) {
        const raw=(error as {code?:unknown})?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'STARTUP_READ_FAILED';
        console.warn('[ApplicationRead]',{operation:'application.startup.read',operationId,stage,result:'failure',code,durationMs:Date.now()-started});
        return {code};
    }
}
function unavailable():never {throw Object.assign(new Error('Requested startup source unavailable'),{code:'STARTUP_SOURCE_UNAVAILABLE'});}
