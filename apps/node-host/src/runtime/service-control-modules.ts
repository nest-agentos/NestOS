import type {RuntimeServiceControl} from '@nestos/app-contracts/services';
import type {RuntimeServiceProject} from '@nestos/app-contracts/services';
import {open,readFile} from 'node:fs/promises';
import {constants,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
/** Only administrator-owned host configuration may load service controller code. */
export function serviceControlModules(primary:RuntimeServiceControl|undefined):RuntimeServiceControl|undefined {
    if(!primary&&!process.env.NESTOS_SERVICE_MODULES&&!existsSync(path.join(homedir(),'.config/nestos/service-modules.json')))return;
    let loaded:Promise<Map<string,RuntimeServiceControl>>|undefined;
    const controllers=()=>loaded??=load(primary);
    const select=async(id?:string)=>{
        if(primary&&(!id||(await primary.describe()).id===id))return primary;
        const entries=await controllers();
        if(id&&entries.has(id))return entries.get(id)!;
        throw Object.assign(new Error('Service target is not registered'),{code:'SERVICE_TARGET_UNAVAILABLE'});
    };
    const authorize=async(id:string,project:RuntimeServiceProject)=>{
        const bindings=await projectBindings();
        const primaryId=process.env.NESTOS_HTTPD_SERVICE_ID;
        if(!bindings.some(row=>(row.serviceId===id||row.serviceId==='httpd'&&id===primaryId)
            && projectFields.every(key=>row[key]===project[key])))throw failure('SERVICE_PROJECT_UNAUTHORIZED');
    };
    return {describeForProject:async(id,project)=>{
            const serviceId=id==='httpd'&&primary?process.env.NESTOS_HTTPD_SERVICE_ID??id:id;
            await authorize(serviceId,project);
            const descriptor=await(await select(serviceId)).describe();
            if(descriptor.id!==serviceId)throw failure('SERVICE_TARGET_MISMATCH');
            return {...descriptor,project};
        },describe:async id=>{const descriptor=await(await select(id)).describe();if(id&&descriptor.id!==id)throw failure('SERVICE_TARGET_MISMATCH');return descriptor;},
        verifyArtifact:async request=>{if(request.project)await authorize(request.serviceId,request.project);const entry=await select(request.serviceId);if(!entry.verifyArtifact)throw Object.assign(new Error('Artifact verification unavailable'),{code:'SERVICE_ARTIFACT_VERIFICATION_UNAVAILABLE'});await entry.verifyArtifact(request);},
        submit:async request=>{if(request.project)await authorize(request.serviceId,request.project);await (await select(request.serviceId)).submit(request);},inspect:async request=>(await select(request.serviceId)).inspect(request),
        provenance:async(version,id)=>(await select(id)).provenance?.(version)};
}
const projectFields=['serverId','serverProjectId','principalId','alias','root'] as const;
type ProjectBinding=RuntimeServiceProject&{serviceId:string};
async function projectBindings():Promise<ProjectBinding[]>{
    let raw=process.env.NESTOS_SERVICE_PROJECTS;
    if(!raw)raw=await readProjectBindings();
    let value:unknown;
    try {value=raw?JSON.parse(raw):[];}catch{throw failure('SERVICE_PROJECT_CONFIGURATION_INVALID');}
    if(!Array.isArray(value)||value.length>128||!value.every(row=>typeof row?.serviceId==='string'
        &&projectFields.every(key=>typeof row[key]==='string'&&row[key].length>0)))throw failure('SERVICE_PROJECT_CONFIGURATION_INVALID');
    return value;
}

async function readProjectBindings():Promise<string|undefined>{
    const file=await open(path.join(homedir(),'.config/nestos/service-projects.json'),constants.O_RDONLY|constants.O_NOFOLLOW)
        .catch(error=>{if(error.code!=='ENOENT')throw failure('SERVICE_PROJECT_CONFIGURATION_INVALID');});
    if(!file)return;
    try{
        const info=await file.stat();
        if(!info.isFile()||(info.mode&0o077)||info.size>128*1024)throw failure('SERVICE_PROJECT_CONFIGURATION_INVALID');
        return await file.readFile('utf8');
    }finally{await file.close();}
}

async function load(primary:RuntimeServiceControl|undefined):Promise<Map<string,RuntimeServiceControl>> {
    let raw=process.env.NESTOS_SERVICE_MODULES;
    if(!raw)try{raw=await readFile(path.join(homedir(),'.config/nestos/service-modules.json'),'utf8');}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
    let modules:unknown;try{modules=raw?JSON.parse(raw):[];}catch{throw failure('SERVICE_MODULE_CONFIGURATION_INVALID');}
    if(!Array.isArray(modules)||modules.length>16)throw failure('SERVICE_MODULE_CONFIGURATION_INVALID');
    const entries=new Map<string,RuntimeServiceControl>();
    if(primary)entries.set((await primary.describe()).id,primary);
    for(const definition of modules){
        if(typeof definition?.id!=='string'||!/^[-\w.]{1,128}$/.test(definition.id)||typeof definition?.module!=='string'||!path.isAbsolute(definition.module))throw failure('SERVICE_MODULE_CONFIGURATION_INVALID');
        if(entries.has(definition.id))throw failure('SERVICE_MODULE_DUPLICATE_TARGET');
        entries.set(definition.id,lazyController(definition));
    }
    return entries;
}

function lazyController(definition:{module:string;options?:unknown}):RuntimeServiceControl {
    let instance:Promise<RuntimeServiceControl>|undefined;
    const get=()=>instance??=import(pathToFileURL(definition.module).href).then(factory=>factory.createServiceControl(definition.options??{}));
    return {describe:async()=> (await get()).describe(),submit:async request=>(await get()).submit(request),inspect:async request=>(await get()).inspect(request),
        verifyArtifact:async request=>{const target=await get();if(!target.verifyArtifact)throw failure('SERVICE_ARTIFACT_VERIFICATION_UNAVAILABLE');await target.verifyArtifact(request);},
        provenance:async version=>(await get()).provenance?.(version)};
}

function failure(code:string):Error{return Object.assign(new Error(code),{code});}
