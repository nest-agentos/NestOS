import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
export function launchHealth(root,args,mode) {
    const flag=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
    const configFile=flag('--config')||path.join(root,'nestos.json');
    const config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
    const settings=config.http?.launcher?.health??{},directory=flag('--cert-dir')||config.http?.certDir||path.join(os.homedir(),'.config/nestos/http-certs');
    const url=new URL(settings.url||`https://127.0.0.1:${flag('--port')||config.http?.port||(mode==='dev'?2001:2000)}/api/health`);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/api/health')throw new Error('HTTPD_HEALTH_CONFIG_INVALID');
    const tls=url.protocol==='https:'?Object.fromEntries([['ca','ca.crt'],['cert','client.crt'],['key','client.key']].map(([key,file])=>[key,readFileSync(settings[key]||path.join(directory,file))])):{};
    const timeoutMs=settings.timeoutMs??120000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)throw new Error('HTTPD_HEALTH_CONFIG_INVALID');
    const probe=version=>new Promise(resolve=>{
        const request=(url.protocol==='https:'?https:http).get(url,{...tls,timeout:1500,agent:false},response=>{
            let text='';response.on('data',chunk=>{text+=chunk;if(text.length>4096)request.destroy();});response.on('end',()=>{try{const value=JSON.parse(text);resolve(response.statusCode===200&&value.ready===true&&value.version===version);}catch{resolve(false);}});
        });request.on('timeout',()=>request.destroy());request.on('error',()=>resolve(false));
    });
    probe.timeoutMs=timeoutMs;return probe;
}
