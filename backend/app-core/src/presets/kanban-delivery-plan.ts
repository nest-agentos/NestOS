import {t} from '@nestos/common';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DeliveryPlan,ReviewJob,ReviewSettings} from '../kanban/item-operation-types';
import {jobKey,reviewKey} from '../kanban/item-operation-types';
import {requireValue} from '../kanban/validation';
import type {DevelopmentPolicy} from './kanban-development-policy';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
interface Profile extends DeliveryPlan {id:string;label:string;readOnly?:boolean}
interface Policy {verificationLevel?:'full'|'quick'|'none';deliveryMode?:'release'|'source';preferenceInstruction?:string;requireSplitJustification?:boolean;schema:1;profiles:Profile[];instruction:string}
const system='nestos-work-delivery';
export function deliveryPolicy(policy:DevelopmentPolicy):Policy|undefined {
    const content=policy.prompts.files.find(file=>file.name==='delivery-policy.json')?.content;if(!content)return;
    let value:Policy;try{value=JSON.parse(content);}catch{throw Object.assign(new Error('Invalid delivery policy'),{code:'DELIVERY_POLICY_INVALID'});}
    requireValue(value?.schema===1&&Array.isArray(value.profiles)&&value.profiles.length===3&&typeof value.instruction==='string'&&value.instruction.length<=8000,'DELIVERY_POLICY_INVALID');
    const expected:Record<string,string[]>={source:['accept','analyze','merge','cleanup'],release:['build','deploy','accept','analyze','merge','cleanup'],verification:['accept','cleanup']};
    requireValue(new Set(value.profiles.map(profile=>profile.id)).size===3&&value.profiles.every(profile=>Array.isArray(profile.steps)&&profile.steps.length===expected[profile.id]?.length&&new Set(profile.steps).size===profile.steps.length&&profile.steps.every(step=>expected[profile.id].includes(step))&&profile.steps.at(-1)==='cleanup'&&profile.acceptance===(profile.id==='release'?'runtime':'source')&&!!profile.readOnly===(profile.id==='verification')),'DELIVERY_POLICY_INVALID');
    return value;
}
export function deliveryProfile(policy:DevelopmentPolicy,item:KanbanItem):Profile|undefined {
    const refs=item.externalRefs?.filter(ref=>ref.system===system)??[];if(!refs.length)return;
    const selected=deliveryPolicy(policy)?.profiles.find(profile=>profile.id===refs[0].id);
    requireValue(refs.length===1&&refs[0].revision==='1'&&selected,'DELIVERY_PROFILE_UNAVAILABLE');return selected.id==='source'?{...selected,acceptanceLabel:t('kanban.operationAcceptSource'),acceptanceConfirmation:t('kanban.operationConfirmSource')}:selected;
}
/** Frozen decision choices override the default release-and-independent-verifier shape. */
export function decisionDeliveryPolicy(policy:DevelopmentPolicy,context:unknown):Policy|undefined {
    const base=deliveryPolicy(policy);if(!base)return;
    const snapshot=(context as {decision?:{snapshot?:{verificationLevel?:'full'|'quick'|'none';deliveryMode?:'release'|'source'}}})?.decision?.snapshot;
    const verificationLevel=snapshot?.verificationLevel??'full',deliveryMode=snapshot?.deliveryMode??'release';
    requireValue(['full','quick','none'].includes(verificationLevel)&&['release','source'].includes(deliveryMode),'DELIVERY_PREFERENCES_INVALID');
    return {...base,verificationLevel,deliveryMode,instruction:base.preferenceInstruction??base.instruction};
}
export function validateDeliveryDecomposition(policy:DevelopmentPolicy,output:unknown,context?:unknown):void {
    const value=output as {ready?:boolean;subtasks?:Array<{key:string;dependsOn:string[];splitJustification?:string;executionProfile?:{system:string;id:string;revision:string}}>};
    const selected=decisionDeliveryPolicy(policy,context);
    const snapshot=(context as {decision?:{snapshot?:{verificationLevel?:string;deliveryMode?:string}}})?.decision?.snapshot;
    if(value?.ready&&(snapshot?.verificationLevel||snapshot?.deliveryMode))requireValue(!!value.subtasks?.length,'DELIVERY_PROFILE_REQUIRED');
    if(!value?.subtasks||!selected)return;
    const tasks=value.subtasks,mode=selected.deliveryMode!,full=selected.verificationLevel==='full';
    requireValue(Array.isArray(tasks)&&tasks.length>0&&tasks.every(task=>task.executionProfile?.system===system&&task.executionProfile.revision==='1'&&selected.profiles.some(profile=>profile.id===task.executionProfile!.id)),'DELIVERY_PROFILE_REQUIRED');
    const integrations=tasks.filter(task=>task.executionProfile!.id===mode),verifiers=tasks.filter(task=>task.executionProfile!.id==='verification');
    requireValue((mode==='release'?integrations.length===1:integrations.length>0&&!tasks.some(task=>task.executionProfile!.id==='release'))&&(full?verifiers.length===1:verifiers.length===0),'DELIVERY_CHAIN_INVALID');
    const ancestors=(key:string,seen=new Set<string>()):Set<string>=>{for(const dependency of tasks.find(task=>task.key===key)?.dependsOn??[]){if(seen.has(dependency))continue;seen.add(dependency);ancestors(dependency,seen);}return seen;};
    const terminal=integrations.filter(task=>integrations.every(other=>other.key===task.key||ancestors(task.key).has(other.key)));
    requireValue(terminal.length===1,'DELIVERY_CHAIN_INVALID');
    if(selected.requireSplitJustification)requireValue(tasks.every(task=>task.executionProfile!.id!=='source'||task===terminal[0]&&mode==='source'||typeof task.splitJustification==='string'&&task.splitJustification.trim().length>=30&&task.splitJustification.length<=2000),'DELIVERY_SPLIT_JUSTIFICATION_REQUIRED');
    const source=ancestors(terminal[0].key);
    requireValue(tasks.every(task=>task.executionProfile!.id!=='source'||task===terminal[0]||source.has(task.key))&&verifiers.every(task=>task.dependsOn.includes(terminal[0].key)),'DELIVERY_CHAIN_INVALID');
}
export function developmentDeliveryPlan(journal:KanbanAutomationJournal,service:{workflow(board:string):Promise<import('@nestos/kanban/contracts').KanbanWorkflowState>}) {
    return async(board:KanbanBoard,item:KanbanItem):Promise<DeliveryPlan>=>{
        const dispatch=Object.values((await service.workflow(board.id)).dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
        const record=dispatch?await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+dispatch.id):undefined;
        const frozen=(record?.context as {delivery?:Profile}|undefined)?.delivery;
        return frozen?{...frozen,...(frozen.id==='source'?{acceptanceLabel:t('kanban.operationAcceptSource'),acceptanceConfirmation:t('kanban.operationConfirmSource')}:{})}:record&&deliveryProfile(record.policy,item)||{steps:['build','deploy','accept','analyze','merge','cleanup'],acceptance:'runtime'};
    };
}
/** Only a confirmed deployment receipt may become the independent verifier's input. */
export async function deliveryEvidence(journal:KanbanAutomationJournal,context:unknown) {
    const value=context as {board?:{id:string};task?:{dependencies:string[]}},evidence=[];
    for(const item of value.task?.dependencies??[]){
        const settings=await journal.get<ReviewSettings>(reviewKey(value.board!.id,item));
        for(const id of settings?.jobs??[]){const job=await journal.get<ReviewJob>(jobKey(id));if(job?.action===((context as {decision?:{snapshot?:{deliveryMode?:string}}})?.decision?.snapshot?.deliveryMode==='source'?'merge':'deploy')&&job.state==='succeeded'&&job.phase==='settled')evidence.push({itemId:item,operationId:job.id,action:job.action,result:job.result});}
    }
    requireValue(evidence.length===1,'VERIFICATION_DEPLOYMENT_REQUIRED');return evidence[0];
}

/** Verification accepts a running release, never uncommitted repairs or another version. */
export function verifyReadOnlyDelivery(record:DevelopmentWorkspaceRecord,repositories:import('../projects/worktree-modules').RepositoryEvidence[],runningVersion?:string) {
    const delivery=(record.context as {delivery?:{readOnly?:boolean;evidence?:{result?:{version?:string}}}})?.delivery;
    if(!delivery?.readOnly)return;
    requireValue(repositories.every(repository=>repository.head===repository.baseCommit&&!repository.dirty),'VERIFICATION_CHANGED_SOURCE');
    if((delivery?.evidence as {action?:string})?.action==='merge')return;
    const expected=delivery.evidence?.result?.version;
    requireValue(typeof expected==='string'&&runningVersion===expected,'VERIFICATION_RUNNING_VERSION_MISMATCH');
}
