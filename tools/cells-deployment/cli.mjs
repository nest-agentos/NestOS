#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {createServiceControl} from './index.mjs';
import {fail} from './artifact.mjs';
import {build, finishedTarget, redeploy, redeployStatus, targetsFor} from './redeploy.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
try{
 const [verb, argument, operation, ...extra] = process.argv.slice(2);
 if (verb === 'redeploy' || verb === 'redeploy-status') {
  const targets = targetsFor(argument);
  if (extra.length || (verb === 'redeploy' && operation)) throw fail('CELLS_REDEPLOY_ARGUMENTS_INVALID');
  const report = verb === 'redeploy'
   ? await redeploy(root, targets)
   : await redeployStatus(root, targets, operation);
  console.log(JSON.stringify(report));
  if (!report.targets.every(finishedTarget)) process.exitCode = 1;
 } else if(verb==='describe'){
  const entries=JSON.parse(await readFile(homedir()+'/.config/nestos/service-modules.json','utf8')),selected=entries.find(entry=>entry.id===process.argv[3]);
  if(!selected)throw fail('SERVICE_TARGET_UNAVAILABLE');
  console.log(JSON.stringify(await(await createServiceControl(selected.options)).describe()));
 }else{
 if(process.argv[2]!=='build')throw fail('CELLS_BUILD_COMMAND_REQUIRED');
 const result=await build(root);
 console.log(JSON.stringify({operation:'cells.build',result:'success',version:result.value.id,evidence:{path:'release/cells/'+result.value.id+'/release.json',sha256:result.digest}}));
}
}catch(error){console.error(JSON.stringify({operation:'cells.'+(process.argv[2]??'build'),result:'failure',code:error.code??'CELLS_BUILD_FAILED'}));process.exitCode=1;}
