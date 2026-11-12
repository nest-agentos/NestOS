import {expect,it} from 'vitest';
import {kanbanVerificationMode} from '@nestos/kanban/contracts';
import defaults from '../src/resources/kanban/kanban-delivery-policy.json';
import {repositoryDeliveryPlan,decisionDeliveryPolicy, selectedDeliveryProfile, deliveryProfile, validateDeliveryDecomposition, verifyReadOnlyDelivery} from '@nestos/git-delivery/policy';
const policy={prompts:{files:[{name:'delivery-policy.json',content:JSON.stringify(defaults)}]}} as any;
const full={decision:{snapshot:{verificationLevel:'full',deliveryMode:'release'}}};
const task=(key:string,id:string,dependsOn:string[]=[])=>({key,dependsOn,...(id==='source'?{splitJustification:'An independently owned library deliverable with its own release and acceptance boundary, beyond this feature implementation.'}:{}),executionProfile:{system:'nestos-work-delivery',id,revision:'1'}});
it('requires one shared release after all source tasks and independent verification after it',()=>{
 const subtasks=[task('a','source'),task('b','source',['a']),task('release','release',['b']),task('verify','verification',['release'])];
 expect(()=>validateDeliveryDecomposition(policy,{subtasks},full)).not.toThrow();
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[...subtasks,task('again','release')]},full)).toThrowError(expect.objectContaining({code:'DELIVERY_CHAIN_INVALID'}));
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[...subtasks,task('unintegrated','source')]},full)).toThrowError(expect.objectContaining({code:'DELIVERY_CHAIN_INVALID'}));
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:subtasks.slice(0,3)},full)).toThrowError(expect.objectContaining({code:'DELIVERY_CHAIN_INVALID'}));
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[task('a','source'),{key:'b',dependsOn:[]}]},full)).toThrowError(expect.objectContaining({code:'DELIVERY_PROFILE_REQUIRED'}));
});
it('does not let a profile grant unrelated external references or change its delivery actions',()=>{
 expect(()=>deliveryProfile(policy,{externalRefs:[{system:'nestos-work-delivery',id:'arbitrary',revision:'1'}]} as any)).toThrowError(expect.objectContaining({code:'DELIVERY_PROFILE_UNAVAILABLE'}));
 const edited=structuredClone(defaults);edited.profiles[0].steps=['accept','cleanup'];
 expect(()=>deliveryProfile({prompts:{files:[{name:'delivery-policy.json',content:JSON.stringify(edited)}]}} as any,{externalRefs:[{system:'nestos-work-delivery',id:'source',revision:'1'}]} as any)).toThrowError(expect.objectContaining({code:'DELIVERY_POLICY_INVALID'}));
});
it('requires verification to preserve source and check the actual frozen release version',()=>{
 const record={context:{delivery:{readOnly:true,evidence:{result:{version:'release-1'}}}}} as any;
 const repositories=[{baseCommit:'a',head:'a',dirty:false}] as any;
 expect(()=>verifyReadOnlyDelivery(record,repositories,'release-1')).not.toThrow();
 expect(()=>verifyReadOnlyDelivery(record,repositories,'old')).toThrowError(expect.objectContaining({code:'VERIFICATION_RUNNING_VERSION_MISMATCH'}));
 expect(()=>verifyReadOnlyDelivery(record,[{baseCommit:'a',head:'b',dirty:false}] as any,'release-1')).toThrowError(expect.objectContaining({code:'VERIFICATION_CHANGED_SOURCE'}));
 expect(()=>verifyReadOnlyDelivery(record,[{baseCommit:'a',head:'a',dirty:true}] as any,'release-1')).toThrowError(expect.objectContaining({code:'VERIFICATION_CHANGED_SOURCE'}));
});

it('accepts the minimum implementation-plus-verification plan and rejects unexplained extra handoffs',()=>{
 const subtasks=[task('implementation','release'),task('verify','verification',['implementation'])];
 expect(()=>validateDeliveryDecomposition(policy,{subtasks},full)).not.toThrow();
 const extra={...task('extra','source'),splitJustification:undefined};
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[extra,task('implementation','release',['extra']),subtasks[1]]},full)).toThrowError(expect.objectContaining({code:'DELIVERY_SPLIT_JUSTIFICATION_REQUIRED'}));
});
it.each([['quick','release','release'],['none','release','release'],['none','build','release'],['none','source','source']])('accepts %s/%s without redundant verification tasks', (verificationLevel,deliveryMode,profile)=>{
 const context={decision:{snapshot:{verificationLevel,deliveryMode}}};
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[task('implementation',profile)]},context)).not.toThrow();
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[task('implementation',profile),task('verify','verification',['implementation'])]},context)).toThrowError(expect.objectContaining({code:'DELIVERY_CHAIN_INVALID'}));
});
it('rejects unsupported combinations and freezes the build-only manual review barrier',()=>{
 for(const [verificationLevel,deliveryMode] of [['full','source'],['quick','source'],['none','invalid']])expect(()=>decisionDeliveryPolicy(policy,{decision:{snapshot:{verificationLevel,deliveryMode}}})).toThrowError(expect.objectContaining({code:'DELIVERY_PREFERENCES_INVALID'}));
 const item={externalRefs:[{system:'nestos-work-delivery',id:'release',revision:'1'}]} as any;
 expect(selectedDeliveryProfile(policy,item,{decision:{snapshot:{verificationLevel:'none',deliveryMode:'build'}}})).toMatchObject({manualAfter:'build'});
 expect(selectedDeliveryProfile(policy,item,{decision:{snapshot:{verificationLevel:'quick',deliveryMode:'release'}}})).not.toHaveProperty('manualAfter');
 expect(selectedDeliveryProfile(policy,item,{decision:{snapshot:{verificationLevel:'none',deliveryMode:'release'}}})).not.toHaveProperty('manualAfter');
});
it('rejects a ready plan that bypasses explicit decision delivery profiles',()=>{
 expect(()=>validateDeliveryDecomposition(policy,{ready:true},{decision:{snapshot:{verificationLevel:'quick',deliveryMode:'release'}}})).toThrowError(expect.objectContaining({code:'DELIVERY_PROFILE_REQUIRED'}));
});

it('defaults to automatic release without optional checks or an independent verifier',()=>{
 expect(decisionDeliveryPolicy(policy,{})).toMatchObject({verificationLevel:'none',deliveryMode:'release'});
 expect(kanbanVerificationMode({})).toBe('release');expect(kanbanVerificationMode({verificationLevel:'full',deliveryMode:'release'})).toBe('full');
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[task('implementation','release')]})).not.toThrow();
 expect(()=>validateDeliveryDecomposition(policy,{subtasks:[task('implementation','release'),task('verify','verification',['implementation'])]})).toThrowError(expect.objectContaining({code:'DELIVERY_CHAIN_INVALID'}));
});

it('keeps build-only delivery before the explicit manual integration boundary',()=>{
 const plan=repositoryDeliveryPlan([{steps:['build','deploy','accept','analyze','merge','cleanup'],acceptance:'runtime',manualAfter:'build'}]);
 expect(plan.steps[0]).toBe('build');expect(plan.manualAfter).toBe('build');
 expect(plan.steps.indexOf('merge')).toBeGreaterThan(plan.steps.indexOf('build'));
});
