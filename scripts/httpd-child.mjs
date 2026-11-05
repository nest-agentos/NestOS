import {pathToFileURL} from 'node:url';
// The server cannot execute before its birth identity and selected version are durable.
const entry=process.argv[2];let admitted=false;
process.once('disconnect',()=>{if(!admitted)process.exit(1);});
process.once('message',async message=>{
    if(message!=='start')process.exit(1);admitted=true;
    process.argv=[process.argv[0],entry,...process.argv.slice(3)];process.disconnect();
    try{await import(pathToFileURL(entry).href);}catch(error){console.error(error);process.exitCode=1;}
});
