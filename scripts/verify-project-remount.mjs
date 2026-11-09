import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {withTemporaryScope,processOutput} from '../tools/temporary-process/node/index.mjs';
const root=process.cwd(),directory=await mkdtemp(join(tmpdir(),'nestos-remount-'));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const endpoint='http://127.0.0.1:'+port,token='local-remount-fixture-0123456789';
async function api(operation,args){const response=await fetch(endpoint+'/v1/api/projects/'+operation,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});const reply=await response.json();if(!reply.ok)throw Error(reply.error?.code??'API_FAILED');return reply.value;}
async function waitReady(){for(let i=0;i<80;i++){try{if((await fetch(endpoint+'/v1/capabilities',{headers:{Authorization:'Bearer '+token}})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('CELLS_NOT_READY');}
function config(alias,path){return `listen="127.0.0.1:${port}"\nallowed_origins=["*"]\nserver_id="remount-fixture"\ntoken="${token}"\n[projects]\nroot=${JSON.stringify(join(directory,'catalog'))}\nisolation="none"\n[[exports]]\nalias=${JSON.stringify(alias)}\npath=${JSON.stringify(path)}\naccess="rw"\n`;}
await withTemporaryScope({scopeId:'project-remount-'+randomUUID()},async scope=>{
 await mkdir(join(directory,'prj/x1'),{recursive:true});await writeFile(join(directory,'old.toml'),config('old',join(directory,'prj/x1')));
 const binary=resolve(root,'tools/cells/target/debug/cells');
 const old=await scope.start(binary,[join(directory,'old.toml')],{cwd:root,timeoutMs:120000});await waitReady();
 const {project}=await api('register',{name:'Fixture',alias:'old',path:'',access:'rw'});await old.stop();
 await writeFile(join(directory,'new.toml'),config('prj',join(directory,'prj')));
 await scope.start(binary,[join(directory,'new.toml')],{cwd:root,timeoutMs:120000});await waitReady();
 let broken=false;try{await api('read',{projectId:project.id});}catch{broken=true;}if(!broken)throw Error('OLD_BINDING_SHOULD_FAIL');
 const build=await(await scope.start(resolve(root,'node_modules/.bin/esbuild'),[resolve(root,'scripts/fixtures/project-remount.ts'),'--bundle','--format=iife','--platform=browser','--outfile='+join(directory,'fixture.js')],{cwd:root,timeoutMs:60000})).result;
 if(build.outcome!=='succeeded')throw Error((await processOutput(undefined,build.id)).output);
 await writeFile(join(directory,'index.html'),`<!doctype html><meta charset="utf-8"><button id="open">Remount</button><main id="editor"></main><button id="confirm">Confirm</button><pre id="result"></pre><script>globalThis.fixture=${JSON.stringify({endpoint,projectId:project.id})}</script><script src="fixture.js"></script>`);
 const browser=await(await scope.start(process.env.KANBAN_BROWSER??'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+join(directory,'chrome'),'--virtual-time-budget=15000','--dump-dom','file://'+join(directory,'index.html')],{cwd:root,timeoutMs:60000})).result;
 const output=(await processOutput(undefined,browser.id)).output;await writeFile(join(directory,'browser.log'),output);
 const encoded=output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];if(!encoded)throw Error('BROWSER_NO_RESULT: '+directory);
 const report=JSON.parse(encoded.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
 report.version={commit:execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim(),workingTree:'dirty',cells:execFileSync('git',['-C','tools/cells','rev-parse','--short','HEAD'],{encoding:'utf8'}).trim()};
 if(report.result!=='passed')throw Error(JSON.stringify(report));
 const current=await api('read',{projectId:project.id});if(current.project.alias!=='prj'||current.project.path!=='x1')throw Error('REBOUND_PROJECT_MISSING');
 await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifacts:directory}));
});
console.log(JSON.stringify({operation:'project.remount.browser',result:'success',cleanup:'confirmed'}));
