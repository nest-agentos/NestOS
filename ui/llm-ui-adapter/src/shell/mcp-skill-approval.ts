import {createModuleLogger,randomUUID,t} from '@nestos/common';
import type {SessionSkillControls} from '@nestos/tools/contracts';
import type {RunAttachmentController} from './RunAttachmentController';
import type {EventEnvelope} from '@nestos/durable-kernel/contracts';

/** Keep one stable request identity until the submitted task has been attached. */
export class McpSkillApprovalAction {
    private readonly pending=new Map<string,{requestId:string;windowId:string;taskId?:string}>();
    private readonly inFlight=new Map<string,Promise<void>>();
    private readonly activating=new Map<string,Promise<void>>();
    constructor(private readonly controls:SessionSkillControls,private readonly sessionId:string,
        private readonly attachment:()=>RunAttachmentController|undefined,private readonly attach:(taskId:string)=>Promise<void>,
        private readonly check:()=>void) {}
    request(skillId:string):Promise<void> {
        const running=this.inFlight.get(skillId);if(running)return running;
        const work=this.run(skillId).finally(()=>{if(this.inFlight.get(skillId)===work)this.inFlight.delete(skillId);});
        this.inFlight.set(skillId,work);return work;
    }
    async observe(event:EventEnvelope):Promise<void> {
        if(!['task.succeeded','task.failed','task.cancelled'].includes(event.type))return;
        const found=[...this.pending].find(([,pending])=>pending.taskId===event.taskId);if(!found)return;
        const [skillId,pending]=found;
        if(event.type!=='task.succeeded'){this.pending.delete(skillId);return;}
        if(!this.controls.activateMcpApproved){this.pending.delete(skillId);return;}
        const current=this.activating.get(skillId);if(current)return current;
        const work=(async()=>{this.check();await this.controls.activateMcpApproved!(this.sessionId,skillId,pending.taskId!,pending.windowId);this.check();
            if(this.pending.get(skillId)===pending)this.pending.delete(skillId);})().finally(()=>{if(this.activating.get(skillId)===work)this.activating.delete(skillId);});
        this.activating.set(skillId,work);return work;
    }
    private async run(skillId:string):Promise<void> {
        const started=Date.now();let stage='validate',operationId:string|undefined;
        try {
            this.check();const attachment=this.attachment();
            if(!attachment||!this.controls.mcpApprovalWindow||!this.controls.requestMcpApproval)throw failure('MCP_SKILL_APPROVAL_UNAVAILABLE',t('skill.approvalUnavailable'));
            const old=this.pending.get(skillId),active=await attachment.current();this.check();
            if(active&&!['succeeded','failed','cancelled'].includes(active.status)&&active.id!==old?.taskId)throw failure('MCP_SKILL_APPROVAL_BUSY',t('skill.approvalTaskBusy'));
            stage='window';const windowId=await this.controls.mcpApprovalWindow(this.sessionId);this.check();
            if(old&&old.windowId!==windowId)throw failure('MCP_SKILL_WINDOW_CHANGED',t('skill.approvalUnavailable'));
            const work:{requestId:string;windowId:string;taskId?:string}=old??{requestId:randomUUID(),windowId};this.pending.set(skillId,work);operationId=work.requestId;
            stage='submit';work.taskId??=await this.controls.requestMcpApproval(this.sessionId,skillId,work.requestId,windowId);this.check();
            stage='attach';await this.attach(work.taskId);this.check();
            report(this.sessionId,operationId,stage,'success',started);
        } catch(error) {report(this.sessionId,operationId,stage,'failure',started,error);throw error;}
    }
}
function failure(code:string,message:string):Error {return Object.assign(new Error(message),{code});}
function report(sessionId:string,operationId:string|undefined,stage:string,result:'success'|'failure',started:number,error?:unknown):void {
    const raw=(error as {code?:unknown}|undefined)?.code;
    const code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:`SKILL_APPROVAL_${stage.toUpperCase()}_FAILED`;
    const fields={operation:'skill.approval.request',operationId,sessionId,stage,result,durationMs:Date.now()-started,...(result==='failure'?{code}:{})};
    try {const log=createModuleLogger('skill-approval');if(result==='success')log.info('Skill approval request',fields);else log.warn('Skill approval request',fields);}catch {/* Diagnostics do not change the task receipt. */}
}
