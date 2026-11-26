import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withTemporaryScope,processOutput} from '../tools/temporary-process/node/index.mjs';
import {assessPerformance} from './performance-budget.mjs';
const root=resolve('.'),environment=resolve(process.env.PERF_ENV??'_nestos/kanban/retained-environment');
const browser=process.env.KANBAN_BROWSER,playwright=process.env.PERF_PLAYWRIGHT;
if(!browser||!playwright)throw Error('BROWSER_OR_PLAYWRIGHT_MISSING');
const results=[];
await withTemporaryScope({scopeId:'http-decision-performance-'+randomUUID(),directory:join(environment,'state/nestos/temporary-process')},async scope=>{
 for(const name of ['baseline','current']){
  const repo=name==='baseline'?join(environment,'baseline'):root,dir=join(environment,'http-decision-'+name+'-'+randomUUID()),ui=join(environment,'http-'+name+'-ui');
  await mkdir(dir,{recursive:true});
  if(name==='baseline')await copyFile(join(root,'apps/http-app/tests/http-decision-perf-fixture.ts'),join(repo,'apps/http-app/tests/http-decision-perf-fixture.ts'));
  const server=await scope.start(join(repo,'apps/http-app/node_modules/.bin/tsx'),[join(repo,'apps/http-app/tests/http-decision-perf-fixture.ts'),dir,ui],{cwd:repo,timeoutMs:180000});
  try {
   const ready=join(dir,'ready.json');let available=false,ended;
   void server.result.then(result=>{ended=result;},error=>{ended={error:String(error)};});
   for(let i=0;i<600&&!ended;i++){try{await readFile(ready);available=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
   if(!available)throw Error('SERVER_NOT_READY '+JSON.stringify(ended));
   const output=join(dir,'report.json');
   const run=await(await scope.start(process.execPath,[join(root,'scripts/fixtures/http-decision/browser.mjs'),ready,output,browser,playwright],{cwd:root,timeoutMs:90000})).result;
   if(run.outcome!=='succeeded')throw Error('BROWSER_FAILED '+(await processOutput(join(environment,'state/nestos/temporary-process'),run.id)).output.slice(-4000));
   const sample=JSON.parse(await readFile(output,'utf8'));sample.version=name==='baseline'?'c27b4f83/a75fe311/b6a79ca6':'c27b4f83-dirty';
   results.push(sample);
  } finally {
   await writeFile(join(dir,'stop'),'');const stopped=await server.result;
   if(stopped.outcome!=='succeeded')throw Error('SERVER_CLEANUP_FAILED '+JSON.stringify(stopped));
  }
 }
 const baseline=assessPerformance(results[0]),current=assessPerformance(results[1],results[0]);
 await writeFile(join(environment,'http-decision-comparison.json'),JSON.stringify({results,baseline,current},null,2));
 if(!baseline.passed||!current.passed||results.some(row=>row.errors.length))throw Error('PERFORMANCE_OR_BROWSER_FAILED '+JSON.stringify({baseline,current,errors:results.map(x=>x.errors)}));
});
console.log(JSON.stringify({operation:'http-decision-performance',result:'success',cleanup:'confirmed',results}));
