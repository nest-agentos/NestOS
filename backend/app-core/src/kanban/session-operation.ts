import type {IndependentCallService} from '@nestos/llm-session';
import type {IndependentCallInput,SubmissionRequest} from '@nestos/llm-session/contracts';
import type {Kernel} from '@nestos/durable-kernel';
import {readContextCatalog} from '../projects/harness-context-catalog';
import {requireValue} from './validation';
export interface OriginalSessionOptions {calls:Pick<IndependentCallService,'inspectTaskCallSubmission'|'list'>;kernel:Pick<Kernel,'inspectSession'|'sessionActivity'>}
/** Bind a new operation to the original Session. Never create a replacement on recovery failure. */
export async function originalSession(options:OriginalSessionOptions,input:IndependentCallInput) {
    const admission=await options.calls.inspectTaskCallSubmission(input);
    requireValue(admission?.executionSessionId,'CONTINUATION_SESSION_UNKNOWN');
    const sessionId=admission.executionSessionId,source=input.request;
    const calls=await options.calls.list({sessionId:source.expectedSessionId!});
    requireValue(calls.length&&calls.every(call=>call.callerState?.settled&&call.executionTree?.settled),'CONTINUATION_IN_USE');
    const activity=await options.kernel.sessionActivity(sessionId);
    requireValue(!Object.entries(activity.counts).some(([key,count])=>['running','queued','created','waiting','blocked','paused'].includes(key)&&count>0),'CONTINUATION_IN_USE');
    const catalog=await readContextCatalog(options.kernel,sessionId),branch=source.expectedBranch!;
    const candidates=Object.values(catalog.value.bindings).filter(binding=>binding.branchId===branch);
    const bindings=candidates.filter(binding=>!(binding.validity==='invalid'&&!binding.nativeRef&&!binding.activeOperation));
    requireValue(bindings.length<=1&&(!candidates.length||bindings.length===1)&&bindings.every(binding=>binding.validity==='valid'&&!binding.activeOperation),'CONTINUATION_CONTEXT_AMBIGUOUS');
    const binding=bindings[0],target=source.expectedTarget!;
    requireValue(target&&branch,'CONTINUATION_CONTEXT_AMBIGUOUS');
    return {sessionId,nativeSessionId:binding?.nativeRef?.sessionId,target,request(id:string,text:string):SubmissionRequest {
        return {expectedSessionId:sessionId,expectedBranch:branch,expectedTarget:target,target:{kind:target.kind,id:target.id,version:target.version},
            source:{kind:'composer',text,attachments:[],values:{}},submission:{id,source:{kind:'conversation',ownerId:sessionId,id}},
            overrides:{...source.overrides,baseRoundId:undefined,newBranchName:undefined,branchMode:'continue',
                ...(binding?{harnessConversation:{mode:'resume',bindingId:binding.id,expectedBindingRevision:binding.revision,expectedGeneration:binding.generation}}:{})}};
    }};
}
