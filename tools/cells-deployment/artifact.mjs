import {createHash,randomUUID} from 'node:crypto';
import {readFile,stat,lstat,copyFile,mkdir,writeFile,rename,rm,open} from 'node:fs/promises';
import path from 'node:path';
export const fail=code=>Object.assign(new Error(code),{code});
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export async function json(file){return JSON.parse(await readFile(file,'utf8'));}
export async function save(file,value){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp',handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 await rename(temp,file);const directory=await open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
}
export async function artifact(root,version){
 if(!validId(version))throw fail('SERVICE_VERSION_INVALID');
 const directory=path.join(root,'release/cells',version);
 for(const relative of ['release','release/cells','release/cells/'+version,'release/cells/'+version+'/release.json','release/cells/'+version+'/cells'])if((await lstat(path.join(root,relative))).isSymbolicLink())throw fail('SERVICE_ARTIFACT_LINK_REJECTED');
 const bytes=await readFile(path.join(directory,'release.json')),value=JSON.parse(bytes);
 if(value.schema!=='nestos.cells.release/1'||value.id!==version||value.binary!=='cells'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.commit!=='string'||!/^[a-f0-9]{40,64}$/.test(value.commit))throw fail('SERVICE_ARTIFACT_INVALID');
 if(value.id!=='cells-'+value.commit.slice(0,8)+'-'+value.sha256.slice(0,16))throw fail('SERVICE_ARTIFACT_VERSION_MISMATCH');
 const binary=path.join(directory,'cells'),metadata=await stat(binary);
 if(!metadata.isFile()||metadata.size!==value.size||digest(await readFile(binary))!==value.sha256)throw fail('SERVICE_ARTIFACT_INVALID');
 return {value,binary,digest:digest(bytes)};
}
export async function packageArtifact(root,commit,binary=path.join(root,'tools/cells/target/release/cells')){
 const bytes=await readFile(binary),sha256=digest(bytes),id='cells-'+commit.slice(0,8)+'-'+sha256.slice(0,16);
 const value={schema:'nestos.cells.release/1',id,commit,binary:'cells',sha256,size:bytes.length};
 const directory=path.join(root,'release/cells',id),temporary=directory+'.'+process.pid+'.tmp';
 await mkdir(temporary,{recursive:true});
 try{await copyFile(binary,path.join(temporary,'cells'));await writeFile(path.join(temporary,'release.json'),JSON.stringify(value));
  try{await rename(temporary,directory);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
 }finally{await rm(temporary,{recursive:true,force:true});}
 return artifact(root,id);
}
