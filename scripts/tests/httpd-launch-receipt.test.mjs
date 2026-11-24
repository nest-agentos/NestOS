import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {changeLaunch,readLaunch,requestLaunch} from '../httpd-launch-state.mjs';

test('records an independently verified running release and preserves idempotency',async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'httpd-running-release-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const old=process.env.NESTOS_HTTPD_CONTROL_DIR;
    process.env.NESTOS_HTTPD_CONTROL_DIR=path.join(root,'launchers');
    t.after(()=>{if(old===undefined)delete process.env.NESTOS_HTTPD_CONTROL_DIR;else process.env.NESTOS_HTTPD_CONTROL_DIR=old;});
    await changeLaunch(root,'release',()=>({schema:1,root,mode:'release',desiredState:'running',serviceId:'test',args:[],currentRelease:'current'}));
    const request={operationId:'accept-existing',action:'switch',targetRelease:'current',expectedCurrent:'current',serviceId:'test'};
    await requestLaunch(root,'release',request,undefined,async()=>true);
    const saved=await readLaunch(root,'release');
    assert.equal(saved.receipts[request.operationId].alreadyRunning,true);
    assert.equal(saved.receipts[request.operationId].version,'current');
    assert.equal(saved.operation,undefined);
    await requestLaunch(root,'release',request,undefined,async()=>assert.fail('Verified receipt should be reused'));
    await assert.rejects(requestLaunch(root,'release',{...request,targetRelease:'other'}),{code:'HTTPD_OPERATION_CONFLICT'});
    const next=await requestLaunch(root,'release',{...request,operationId:'ordinary-switch',targetRelease:'other'},undefined,async()=>assert.fail('Different release cannot be reconciled'));
    assert.equal(next.operation.target,'other');
    assert.equal(next.receipts['ordinary-switch'],undefined);
});
