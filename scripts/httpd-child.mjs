import {pathToFileURL} from 'node:url';
import {runtimeLog,runtimePaths} from './httpd-runtime.mjs';
import {installProcessDiagnostics,processErrorMetadata} from './httpd-diagnostics.mjs';
// Write terminal receipts synchronously; the launcher's stdout pipe may already be gone.
const output=runtimeLog(runtimePaths(process.env.NESTOS_HTTPD_MODE??'release').runtime);
const diagnostics=installProcessDiagnostics({role:'server',mode:process.env.NESTOS_HTTPD_MODE??'release',
    version:process.env.NESTOS_HTTPD_VERSION,serviceId:process.env.NESTOS_HTTPD_SERVICE_ID,
    operationId:process.env.NESTOS_HTTPD_PROCESS_ID},event=>output.write(Buffer.from('[HTTPProcess] '+JSON.stringify({
        time:new Date().toISOString(),operation:'http.process',...event})+'\n')));
process.once('exit',()=>output.close());
// The server cannot execute before its birth identity and selected version are durable.
const entry=process.argv[2];let admitted=false;
process.once('disconnect',()=>{if(!admitted){diagnostics.log({stage:'server.admission',result:'failure',code:'HTTPD_LAUNCHER_DISCONNECTED'});process.exit(1);}});
process.once('message',async message=>{
    if(message!=='start'){diagnostics.log({stage:'server.admission',result:'failure',code:'HTTPD_START_MESSAGE_INVALID'});process.exit(1);}admitted=true;
    process.argv=[process.argv[0],entry,...process.argv.slice(3)];process.disconnect();
    try{await import(pathToFileURL(entry).href);diagnostics.log({stage:'server.import',result:'success'});}
    catch(error){diagnostics.log({stage:'server.import',result:'failure',code:'HTTPD_SERVER_IMPORT_FAILED',...processErrorMetadata(error)});process.exitCode=1;}
});
