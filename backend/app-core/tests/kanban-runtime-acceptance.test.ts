import {afterEach,expect,it,vi} from 'vitest';
import {compatibleRuntimeDelivery} from '../src/presets/kanban-runtime-acceptance';
const state=vi.hoisted(()=>({changed:false,ancestor:true,module:false}));
vi.mock('@nestos/git-delivery/repositories',()=>({gitWorkspace:vi.fn(async(_process,_directory,args)=>{
    if(args[0]==='rev-parse')return {stdout:'a'.repeat(40)+'\n',code:0};
    if(args.includes('ls-tree'))return {stdout:state.module?'160000 commit '+ 'd'.repeat(40)+'\tlibraries/mail\0':'',code:0};
    if(args[0]==='show')return {stdout:JSON.stringify({name:'@test/library'}),code:0};
    if(args[0]==='merge-base')return {stdout:'',code:state.ancestor?0:1};
    return {stdout:args[0]==='--literal-pathspecs'?(state.changed?'task.ts\0':''):'task.ts\0libraries/mail\0',code:0};
})}));
afterEach(()=>{state.changed=false;state.ancestor=true;state.module=false;});
const record={channelId:'task',directory:'/workspace/task',repositories:[{path:'.',baseCommit:'b'.repeat(40)}],context:{decision:{snapshot:{verificationLevel:'none',deliveryMode:'release'}}}};
const proof={serviceId:'service',version:'newer',sourceCommit:'c'.repeat(40)};
it('adopts a trusted descendant runtime only while the task delivery paths remain unchanged',async()=>{
    const value=await compatibleRuntimeDelivery({} as never,record as never,proof,'older');
    expect(value).toMatchObject({version:'newer',receipt:{previousVersion:'older',sourceCommit:'a'.repeat(40),runtimeCommit:proof.sourceCommit,taskPathCount:2,verification:'not-requested'}});
});
it.each(['full','quick'])('does not substitute provenance for %s functional verification',async verificationLevel=>{
    const value={...record,context:{decision:{snapshot:{verificationLevel,deliveryMode:'release'}}}};
    expect(await compatibleRuntimeDelivery({} as never,value as never,proof,'older')).toBeUndefined();
});
it('refuses changed task files or a runtime that does not contain the task commit',async()=>{
    state.changed=true;expect(await compatibleRuntimeDelivery({} as never,record as never,proof,'older')).toBeUndefined();
    state.changed=false;state.ancestor=false;expect(await compatibleRuntimeDelivery({} as never,record as never,proof,'older')).toBeUndefined();
});

it('requires unchanged shipped package fingerprints for task-owned submodules',async()=>{
 state.module=true;
 expect(await compatibleRuntimeDelivery({} as never,record as never,proof,'older')).toBeUndefined();
 const dependencies={'@test/library':{current:'1'.repeat(64),previous:'2'.repeat(64)}};
 expect(await compatibleRuntimeDelivery({} as never,record as never,{...proof,dependencies},'older')).toBeUndefined();
 dependencies['@test/library'].previous='1'.repeat(64);
 expect(await compatibleRuntimeDelivery({} as never,record as never,{...proof,dependencies},'older')).toMatchObject({version:'newer'});
});
