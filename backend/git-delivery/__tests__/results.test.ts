import {expect,it} from 'vitest';
import {validateOperationResult} from '../src/results';
import type {GitOperationReceiptScope} from '../src/contracts';
const scope:GitOperationReceiptScope={id:'operation',action:'deploy',requireStatus:true,expectedVersion:'release-1',snapshot:{sourceVersion:'source',targetVersion:'target'}};
const receipt={schema:'nestos.kanban.operation-result/1',operationId:'operation',sourceVersion:'source',targetVersion:'target',status:'succeeded',version:'release-1'};
it('requires frozen identity and version before accepting a successful receipt',()=>{
    expect(()=>validateOperationResult(scope,receipt)).not.toThrow();
    expect(()=>validateOperationResult(scope,{...receipt,targetVersion:'changed'})).toThrow('OPERATION_RESULT_SCOPE_MISMATCH');
    expect(()=>validateOperationResult(scope,{...receipt,version:'release-2'})).toThrow('OPERATION_RESULT_VERSION_MISMATCH');
    expect(()=>validateOperationResult(scope,{...receipt,status:undefined})).toThrow('OPERATION_RESULT_INVALID');
});
it('retains structured blocked evidence and rejects ambiguous conflict choices',()=>{
    const blocked={...receipt,status:'blocked',summary:'Needs user decision'};
    try{validateOperationResult(scope,blocked);throw new Error('Expected blocked receipt');}
    catch(error){expect(error).toMatchObject({code:'OPERATION_RESULT_AGENT_BLOCKED',result:blocked});}
    expect(()=>validateOperationResult({...scope,action:'analyze'},{sourceVersion:'source',targetVersion:'target',summary:'Choose',conflicts:[
        {id:'conflict',path:'file',reason:'Both modified',options:[{id:'one',label:'One'},{id:'one',label:'Duplicate'}]}
    ]})).toThrow('MERGE_PLAN_OPTION_INVALID');
});
