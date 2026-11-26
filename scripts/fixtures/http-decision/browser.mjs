import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [readyPath,outputPath,browserPath,playwrightPath]=process.argv.slice(2);
const ready=JSON.parse(await readFile(readyPath,'utf8'));
const {chromium}=await import(pathToFileURL(playwrightPath).href);
const browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900},clientCertificates:[{origin:ready.origin,certPath:path.join(ready.certs,'client.crt'),keyPath:path.join(ready.certs,'client.key')}]});
const page=await context.newPage(),requests=[],errors=[];let measuring=true;
page.on('request',request=>{if(!measuring)return;const url=new URL(request.url()),entry={path:url.pathname,method:request.method(),logical:0};
 if(url.pathname==='/api/application'&&request.method()==='POST'){
  try{const packet=JSON.parse(request.postData()??'');if(['queries','bindings'].includes(packet.kind)){if(!Array.isArray(packet.calls)||!packet.calls.length)entry.unknown=true;else entry.logical=packet.calls.length;}
   else if(packet.kind==='call'&&packet.call?.method)entry.logical=1;
   else if(['bootstrap','bootstrap-data','updates-read','close','reply'].includes(packet.kind))entry.logical=1;else entry.unknown=true;
  }catch{entry.unknown=true;}
 }else if(url.pathname.startsWith('/api/')&&!url.pathname.includes('/events'))entry.logical=1;
 requests.push(entry);
});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(measuring&&response.status()>=400)errors.push('HTTP_'+response.status()+' '+new URL(response.url()).pathname);});
page.on('requestfailed',request=>{if(measuring)errors.push('REQUEST_FAILED '+new URL(request.url()).pathname);});
const started=performance.now();
try{
 await page.goto(ready.origin+'/#/kanban/%2Fboard%2Fperf-board%2F%40decision',{waitUntil:'domcontentloaded',timeout:30000});
 await page.locator('.kanban__decision-table tbody tr[data-decision-row]').first().waitFor({state:'visible',timeout:30000});
 await page.locator('.kanban__decision-filters').waitFor({state:'visible',timeout:30000});
 if(await page.locator('.kanban__decision-table tbody tr[data-decision-row]').count()!==50)throw Error('EXPECTED_FIRST_PAGE_50');
 const filter=page.locator('[data-action=decision-filter-states]');
 if(await filter.count()!==1)throw Error('FILTER_UNAVAILABLE');
 const durationMs=performance.now()-started;measuring=false;
 const result={completed:true,durationMs,apiCalls:requests.reduce((n,r)=>n+r.logical,0),httpRequests:requests.length,unknownRequests:requests.filter(r=>r.unknown).length,errors,requests,dataset:'100-decisions-2-projects',scope:'cold-decision-http',backgroundLoad:'none'};
 await writeFile(outputPath,JSON.stringify(result,null,2));
}finally{await context.close();await browser.close();}
