import {randomUUID} from '@nestos/common';
import {FSError} from '@nestos/vfs-core';
import type {ApplicationBackend,ApplicationServices,StartupReadRequest,StartupReadResult,StartupReadSection} from '@nestos/app-contracts/services';
/** Compose only requested reads through their existing authorized domain ports. */
export async function readStartup(backend:ApplicationBackend,services:Pick<ApplicationServices,'kanban'>,request:StartupReadRequest):Promise<StartupReadResult> {
    validateRequest(request);
    const operationId=randomUUID();
    const notifications=request.task&&request.eventBaseline&&backend.events?.notificationSummary?
        await readSection(operationId,'notifications',()=>backend.events!.notificationSummary!()):undefined;
    const eventBaseline=notifications?.value?{value:notifications.value.head}:
        request.eventBaseline?await readSection(operationId,'events',()=>backend.events?backend.events.eventBaseline():unavailable()):undefined;
    const [documents,decision,task]=await Promise.all([
        request.documents?readSection(operationId,'documents',()=>backend.readUiDocuments(request.documents!)):undefined,
        request.decision?readSection(operationId,'decision',()=>services.kanban?.decisionSnapshot?services.kanban.decisionSnapshot(request.decision!.boardId,request.decision!.query):unavailable()):undefined,
        request.task?readSection(operationId,'task',()=>services.kanban?.taskSnapshot?services.kanban.taskSnapshot(request.task!.boardId,request.task!.itemId,
            request.task!.includeSidebar===undefined?undefined:{includeSidebar:request.task!.includeSidebar}):unavailable()):undefined,
    ]);
    const unreadNotifications=notifications?.value?{value:notifications.value.unread}:notifications?.code?{code:notifications.code}:undefined;
    return {request,eventBaseline,documents,decision,...(task?{task}:{}),...(unreadNotifications?{unreadNotifications}:{})};
}
function validateRequest(request:StartupReadRequest):void {
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['documents','eventBaseline','decision','task'].includes(key)))throw new FSError('EINVAL','Invalid startup read');
    if(request.eventBaseline!==undefined&&typeof request.eventBaseline!=='boolean')throw new FSError('EINVAL','Invalid event baseline request');
    validateDocuments(request.documents);validateDecision(request.decision);
    if(request.task!==undefined&&(!request.task||request.decision||typeof request.task.boardId!=='string'||!request.task.boardId||typeof request.task.itemId!=='string'||!request.task.itemId
        ||(request.task.includeSidebar!==undefined&&typeof request.task.includeSidebar!=='boolean')))throw new FSError('EINVAL','Invalid task read');
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
