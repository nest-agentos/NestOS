import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail} from './artifact.mjs';
const exec=promisify(execFile);
export async function command(file,args,timeout=15000){
 try{return (await exec(file,args,{timeout,maxBuffer:262144,killSignal:'SIGKILL'})).stdout.trim();}
 catch(error){const message=String(error.stderr??'');const code=error.killed?'SERVICE_COMMAND_TIMEOUT':/no new privileges|password is required/.test(message)?'SERVICE_PRIVILEGE_UNAVAILABLE':/Permission denied.*publickey/.test(message)?'SERVICE_SSH_AUTH_FAILED':/Host key verification failed/.test(message)?'SERVICE_SSH_HOST_KEY_MISMATCH':'SERVICE_COMMAND_EXIT_'+String(error.code??'UNKNOWN');throw fail(code);}
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export async function ready(options){
 const value=JSON.parse(await command('sudo',['-n',options.server,'service','status',options.vm]));
 if(value.service!==options.id||value.vm!==options.vm||value.rootDisk?.retained!==true)throw fail('SERVICE_BINDING_MISMATCH');
 return value.state==='ready';
}
export async function runningHash(options){
 const address=await command('sudo',['-n',options.server,'network','address',options.vm]),[ip,alias]=address.split(/\s+/);
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(ip)||!/^nestos-[\w-]+$/.test(alias))throw fail('SERVICE_ADDRESS_INVALID');
 const code='import pathlib,hashlib,json; target='+JSON.stringify(options.executable)+'; rows=[]\nfor p in pathlib.Path("/proc").iterdir():\n if p.name.isdigit():\n  try:\n   e=p/"exe"\n   if str(e.readlink()).removesuffix(" (deleted)")==target: rows.append(hashlib.sha256(e.read_bytes()).hexdigest())\n  except (OSError,PermissionError): pass\nif len(rows)!=1: raise RuntimeError("SERVICE_PROCESS_UNVERIFIED")\nprint(rows[0])';
 const hash=await command('sudo',['-n','ssh','-F','/dev/null','-T','-i',options.identity,'-o','BatchMode=yes','-o','ConnectTimeout=3','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/var/lib/nestos-firecracker/services/known_hosts','-o','HostKeyAlias='+alias,'agent@'+ip,'python3 -c '+quote(code)]);
 if(!/^[a-f0-9]{64}$/.test(hash))throw fail('SERVICE_PROCESS_UNVERIFIED');
 return hash;
}
