import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureNativeRuntime} from '../httpd-native-runtime.mjs';

function runner(results){const calls=[];return {calls,runCommand:(command,args)=>{calls.push({command,args});return results.shift();}};}
test('a healthy installation needs no rebuild',()=>{
    const f=runner([{status:0,output:''}]);ensureNativeRuntime('/source',{...f,log(){}});
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].args.at(-1),'/source/apps/http-app');
});
test('missing pty rebuilds only its package and verifies the resulting binding',()=>{
    const f=runner([{status:1,output:'package=node-pty result=failure code=MODULE_NOT_FOUND'},{status:0,output:''},{status:0,output:''}]),logs=[];
    ensureNativeRuntime('/source',{...f,operationId:'op',log:value=>logs.push(value)});
    assert.deepEqual(f.calls[1],{command:'pnpm',args:['--config.ignore-scripts=false','--filter','@nestos/http-app','rebuild','node-pty']});
    assert.equal(f.calls.length,3);assert.match(logs.at(-1),/operationId=op.*result=success cache=rebuilt/);
});
test('a failed native build cannot be accepted as a reusable runtime',()=>{
    const f=runner([{status:1,output:'package=node-pty result=failure'},{status:1,output:'node-gyp failed'}]);
    assert.throws(()=>ensureNativeRuntime('/source',{...f,log(){}}),error=>error.code==='NATIVE_RUNTIME_PREPARATION_FAILED'&&error.message.includes('node-gyp failed'));
    assert.equal(f.calls.length,2);
});
test('a successful lifecycle script still requires a loadable native output',()=>{
    const f=runner([{status:1,output:'package=node-pty result=failure'},{status:0,output:''},{status:1,output:'package=node-pty result=failure: pty.node absent'}]);
    assert.throws(()=>ensureNativeRuntime('/source',{...f,log(){}}),error=>error.code==='NATIVE_RUNTIME_PREPARATION_FAILED'&&error.message.includes('pty.node absent'));
});
test('multiple damaged native dependencies are repaired together',()=>{
    const f=runner([{status:1,output:'package=better-sqlite3 result=failure\npackage=node-pty result=failure'},{status:0,output:''},{status:0,output:''}]);
    ensureNativeRuntime('/source',{...f,log(){}});
    assert.deepEqual(f.calls[1].args.slice(-2),['better-sqlite3','node-pty']);
});

test('missing native compiler tools retain the concrete cause and recovery action',()=>{
    const f=runner([{status:1,output:'package=node-pty result=failure'},{status:1,output:'gyp ERR! stack Error: not found: make'}]),logs=[];
    assert.throws(()=>ensureNativeRuntime('/source',{...f,operationId:'missing-tools',log:value=>logs.push(value)}),error=>
        error.code==='NATIVE_BUILD_TOOLCHAIN_MISSING'&&error.missingTools[0]==='make'&&error.message.includes('build-essential')&&error.message.includes('not found: make'));
    assert.match(logs.at(-1),/operationId=missing-tools.*result=failure.*code=NATIVE_BUILD_TOOLCHAIN_MISSING missing=make.*durationMs=/);
    assert.equal(f.calls.length,2);
});
