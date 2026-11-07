import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const require=createRequire(resolve(process.argv[2]??'.','package.json'));
const checks={
    'better-sqlite3':()=>{const Database=require('better-sqlite3'),db=new Database(':memory:');
        try{assert.equal(db.prepare('select 42 as value').get().value,42);}finally{db.close();}},
    'node-pty':()=>assert.equal(typeof require('node-pty').spawn,'function'),
    sharp:async()=>{await require('sharp')({create:{width:1,height:1,channels:3,background:'#000'}}).png().toBuffer();},
};
for(const [name,check] of Object.entries(checks)) {
    const started=Date.now();
    try{await check();console.log(`[NodeRuntime] stage=native-bindings package=${name} result=success durationMs=${Date.now()-started}`);}
    catch(error){
        console.error(`[NodeRuntime] stage=native-bindings package=${name} result=failure durationMs=${Date.now()-started} code=${error.code??'NATIVE_BINDING_UNAVAILABLE'} node=${process.version} abi=${process.versions.modules} platform=${process.platform} arch=${process.arch} reason=${error.message}`);
        process.exitCode=1;
    }
}
