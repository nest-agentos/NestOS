import {mkdtemp,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {withTemporaryScope,processOutput} from '../tools/temporary-process/node/index.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),base=resolve(root,'_nestos/kanban/artifacts');
await mkdir(base,{recursive:true});
for(const [name,folder] of [['XDG_STATE_HOME','state'],['XDG_CACHE_HOME','cache'],['TMPDIR','tmp']]){process.env[name]=join(base,folder);await mkdir(process.env[name],{recursive:true});}
const directory=await mkdtemp(join(base,'recurrence-browser-'));
const browser=process.env.KANBAN_BROWSER;if(!browser)throw Error('KANBAN_BROWSER_REQUIRED');
const require=createRequire(import.meta.url),esbuild=require.resolve('esbuild/bin/esbuild',{paths:[require.resolve('tsup')]});
await withTemporaryScope({scopeId:'recurrence-browser-'+randomUUID()},async scope=>{
 const build=await(await scope.start(esbuild,[resolve(root,'scripts/fixtures/kanban-recurrence-browser.ts'),'--bundle','--format=iife','--platform=browser','--loader:.css=empty','--outfile='+join(directory,'fixture.js')],{cwd:root,timeoutMs:60000})).result;
 if(build.outcome!=='succeeded')throw Error('BUILD_FAILED: '+(await processOutput(undefined,build.id)).output);
 await copyFile(resolve(root,'libraries/kanban-ui/src/kanban.css'),join(directory,'kanban.css'));
 await writeFile(join(directory,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="kanban.css"><style>html,body,#editor{height:100%;margin:0}</style><main id="editor"></main><pre id="result"></pre><script src="fixture.js"></script>');
 const result=await(await scope.start(browser,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+join(directory,'profile'),'--window-size=1280,900','--virtual-time-budget=30000','--dump-dom','file://'+join(directory,'index.html')],{cwd:root,timeoutMs:60000})).result;
 const output=(await processOutput(undefined,result.id)).output;await writeFile(join(directory,'browser.log'),output);
 const encoded=output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
 if(result.outcome!=='succeeded'||!encoded)throw Error('BROWSER_ACCEPTANCE_FAILED: '+directory);
 const report=JSON.parse(encoded.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
 await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));if(report.result!=='passed')throw Error('BROWSER_ASSERTION_FAILED: '+JSON.stringify(report));
 console.log(JSON.stringify({...report,artifacts:directory}));
});
console.log(JSON.stringify({operation:'kanban.recurrence.browser',result:'success',cleanup:'confirmed'}));
