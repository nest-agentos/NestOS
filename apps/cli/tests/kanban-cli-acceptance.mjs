import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../../..');
const directory=await mkdtemp(path.join(tmpdir(),'kanban-cli-acceptance-'));
const artifacts=path.resolve(process.env.KANBAN_ARTIFACTS||path.join(directory,'artifacts'));
await mkdir(artifacts,{recursive:true});
let serial=0;const evidence=[];
async function invoke(args,input,expected=0) {
    if(input){const file=path.join(artifacts,'request-'+ ++serial+'.json');await writeFile(file,JSON.stringify(input,null,2));args=[...args,'--file',file];}
    const result=spawnSync(process.execPath,[path.join(root,'apps/cli/dist/cli.js'),...args,'--profile',path.join(directory,'data'),'--auth-dir',path.join(directory,'auth'),'--audit-file',path.join(directory,'audit.jsonl')],{encoding:'utf8',timeout:30000});
    await writeFile(path.join(artifacts,'command-'+evidence.length+'.log'),result.stdout+result.stderr);
    evidence.push({args:args.slice(0,3),status:result.status});assert.equal(result.status,expected,result.stderr);
    if(expected!==0)return result;
    const start=Math.max(result.stdout.lastIndexOf('\n{'),result.stdout.lastIndexOf('\n['));
    return JSON.parse(result.stdout.slice(start+1));
}
const actor={kind:'human',id:'admin'};
await invoke(['kanban','create'],{id:'controls',title:'CLI controls fixture',scope:{kind:'system'},members:[{...actor,responsibility:'Verify',roles:['worker','coordinator','reviewer']}],policy:{requireEstimate:false,review:'independent'}});
async function execute(command,expected=0){const board=await invoke(['kanban','show','controls']);return invoke(['kanban','execute','controls'],{operationId:'cli-op-'+ ++serial,expectedRevision:board.revision,command},expected);}
await execute({type:'create-item',item:{id:'task',title:'CLI task',responsibility:'Verify controls',acceptance:'Checks pass'}});
let item=await invoke(['kanban','item','controls','task']);assert.equal(item.task.phase,'waiting-start');assert.equal(item.task.startAt-item.item.createdAt,300000);const startAt=item.task.startAt;
await execute({type:'begin-edit',itemId:'task',editId:'editor',leaseMs:300000});
const blocked=await execute({type:'request-run',itemId:'task'},2);assert.match(blocked.stderr,/EDIT_LEASE_ACTIVE/);
await execute({type:'end-edit',itemId:'task',editId:'editor'});await execute({type:'request-run',itemId:'task'});
item=await invoke(['kanban','item','controls','task']);assert.equal(item.task.startAt,startAt);
await execute({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'cli-plan',revision:1,sealed:true,items:[{id:'task',expectedRevision:item.item.revision,title:item.item.title,responsibility:item.item.responsibility,acceptance:item.item.acceptance,assignee:actor,dependsOn:[]}]}});
await execute({type:'prepare-dispatch',itemId:'task',dispatchId:'isolated-host-fixture'});
const workflow=await invoke(['kanban','workflow','controls']),dispatch=workflow.dispatches['isolated-host-fixture'];
const frozen=await execute({type:'begin-edit',itemId:'task',editId:'late-editor',leaseMs:1000},2);assert.match(frozen.stderr,/TASK_DEFINITION_FROZEN/);
await execute({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded'});
item=await invoke(['kanban','item','controls','task']);assert.equal(item.task.phase,'review');
const selfReview=await execute({type:'accept-execution',dispatchId:dispatch.id,accept:true},2);assert.match(selfReview.stderr,/INDEPENDENT_REVIEW_REQUIRED/);
item=await invoke(['kanban','item','controls','task']);assert.equal(item.task.phase,'review');assert.ok(!item.task.actions.includes('run'));
await writeFile(path.join(artifacts,'result.json'),JSON.stringify({result:'passed',commands:evidence.length,environment:'isolated CLI profile; synthetic host execution observations; no remote/native call; owner self-review correctly rejected; independent completion covered by browser/RPC tests',evidence,item},null,2));
console.log(JSON.stringify({result:'passed',commands:evidence.length,artifacts}));
