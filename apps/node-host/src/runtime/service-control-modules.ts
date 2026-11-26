import type {RuntimeServiceControl} from '@nestos/app-contracts/services';
import type {RuntimeServiceProject} from '@nestos/app-contracts/services';
import {open,readFile,realpath} from 'node:fs/promises';
import {constants,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {projectServiceDiagnostics} from '../logging/project-service-diagnostics';
import {diagnosticSources,ServiceDiagnosticGrants} from './service-diagnostic-grants';
/** Only administrator-owned host configuration may load service controller code. */
export function serviceControlModules(primary:RuntimeServiceControl|undefined,
    grants=new ServiceDiagnosticGrants(path.join(homedir(),'.config/nestos/service-diagnostics'))):RuntimeServiceControl|undefined {
    if(!primary&&!process.env.NESTOS_SERVICE_MODULES&&!existsSync(path.join(homedir(),'.config/nestos/service-modules.json')))return;
    let loaded:Promise<Map<string,RuntimeServiceControl>>|undefined;
    const controllers=()=>loaded??=load(primary);
    if(primary&&process.env.NESTOS_HTTPD_SERVICE_ID)void reportSelfSource(process.env.NESTOS_HTTPD_SERVICE_ID,process.env.INIT_CWD);
    const select=async(id?:string)=>{
        if(primary&&(!id||(await primary.describe()).id===id))return primary;
        const entries=await controllers();
        if(id&&entries.has(id))return entries.get(id)!;
        throw Object.assign(new Error('Service target is not registered'),{code:'SERVICE_TARGET_UNAVAILABLE'});
    };
    const authorize=async(id:string,project:RuntimeServiceProject)=>{
        const bindings=await projectBindings();
        const primaryId=process.env.NESTOS_HTTPD_SERVICE_ID;
        const matches=bindings.filter(row=>(row.serviceId===id||row.serviceId==='httpd'&&id===primaryId)
            && projectFields.every(key=>row[key]===project[key]));
        if(!matches.length)throw failure('SERVICE_PROJECT_UNAUTHORIZED');
        for(const row of matches){
            if(!row.sourceCheckout||primary&&id===primaryId&&await matchesSourceCheckout(row.sourceCheckout,process.env.INIT_CWD))return row;
        }
        throw failure('SERVICE_PROJECT_SOURCE_CHECKOUT_MISMATCH');
    };
    const diagnosticBinding=async(project:RuntimeServiceProject)=>{
        if(!primary)throw failure('SERVICE_TARGET_UNAVAILABLE');
        const serviceId=(await primary.describe()).id,row=await authorize(serviceId,project);
        return {key:createHash('sha256').update(JSON.stringify([serviceId,...projectFields.map(key=>row[key]),row.sourceCheckout])).digest('hex'),
            defaults:row.diagnostics===true?[...diagnosticSources]:[]};
    };
    const diagnostics:Pick<RuntimeServiceControl,'readDiagnosticsForProject'|'diagnosticAccess'|'saveDiagnosticAccess'>=
        primary&&process.env.NESTOS_HTTPD_SERVICE_ID?{
            diagnosticAccess:async project=>{const {key,defaults}=await diagnosticBinding(project);return grants.read(key,defaults);},
            saveDiagnosticAccess:async(project,change)=>{const {key,defaults}=await diagnosticBinding(project);return grants.save(key,defaults,change);},
            readDiagnosticsForProject:async(project,projectId,query)=>{
                const {key,defaults}=await diagnosticBinding(project),access=await grants.read(key,defaults);
                if(!access.sources.length)throw failure('SERVICE_DIAGNOSTICS_DISABLED');
                return projectServiceDiagnostics({id:projectId,nodeId:project.serverProjectId,serverId:project.serverId},query,undefined,undefined,access.sources);
            },
        }:{};
    return {...diagnostics,describeForProject:async(id,project)=>{
            const serviceId=id==='httpd'&&primary?process.env.NESTOS_HTTPD_SERVICE_ID??id:id;
            await authorize(serviceId,project);
            const descriptor=await(await select(serviceId)).describe();
            if(descriptor.id!==serviceId)throw failure('SERVICE_TARGET_MISMATCH');
            return {...descriptor,project};
        },describe:async id=>{const descriptor=await(await select(id)).describe();if(id&&descriptor.id!==id)throw failure('SERVICE_TARGET_MISMATCH');return descriptor;},
        verifyArtifact:async request=>{if(request.project)await authorize(request.serviceId,request.project);const entry=await select(request.serviceId);if(!entry.verifyArtifact)throw Object.assign(new Error('Artifact verification unavailable'),{code:'SERVICE_ARTIFACT_VERIFICATION_UNAVAILABLE'});await entry.verifyArtifact(request);},
        runningArtifact:async request=>{await authorize(request.serviceId,request.project);return (await select(request.serviceId)).runningArtifact?.(request);},
        preparedArtifact:async request=>{await authorize(request.serviceId,request.project);return (await select(request.serviceId)).preparedArtifact?.(request);},
        submit:async request=>{if(request.project)await authorize(request.serviceId,request.project);await (await select(request.serviceId)).submit(request);},inspect:async request=>(await select(request.serviceId)).inspect(request),
        provenance:async(version,id)=>(await select(id)).provenance?.(version)};
}
async function reportSelfSource(serviceId:string,active:string|undefined):Promise<void>{
    const operationId=randomUUID(),started=Date.now();
    let code='SERVICE_PROJECT_BINDING_REQUIRED';
    try{
        const rows=(await projectBindings()).filter(row=>row.sourceCheckout&&(row.serviceId===serviceId||row.serviceId==='httpd'));
        if(rows.length)code='SERVICE_PROJECT_SOURCE_CHECKOUT_MISMATCH';
        for(const row of rows)if(await matchesSourceCheckout(row.sourceCheckout!,active)){code='SERVICE_PROJECT_SOURCE_CHECKOUT_MATCHED';break;}
    }catch{code='SERVICE_PROJECT_CONFIGURATION_INVALID';}
    console.info('[ServiceProject]',JSON.stringify({operation:'service.project',operationId,stage:'startup.source',
        result:code==='SERVICE_PROJECT_SOURCE_CHECKOUT_MATCHED'?'success':'failure',code,durationMs:Date.now()-started}));
}
const projectFields=['serverId','serverProjectId','principalId','alias','root'] as const;
type ProjectBinding=RuntimeServiceProject&{serviceId:string;sourceCheckout?:string;diagnostics?:boolean};
async function matchesSourceCheckout(expected:string,active:string|undefined):Promise<boolean>{
    if(!active||!path.isAbsolute(active))return false;
    try{return (await realpath(expected))===(await realpath(active));}catch{return false;}
}
async function projectBindings():Promise<ProjectBinding[]>{
    let raw=process.env.NESTOS_SERVICE_PROJECTS;
    if(!raw)raw=await readProjectBindings();
    let value:unknown;
    try {value=raw?JSON.parse(raw):[];}catch{throw failure('SERVICE_PROJECT_CONFIGURATION_INVALID');}
    if(!Array.isArray(value)||value.length>128||!value.every(row=>typeof row?.serviceId==='string'
        &&projectFields.every(key=>typeof row[key]==='string'&&row[key].length>0)
        &&(row.diagnostics===undefined||typeof row.diagnostics==='boolean')
        &&(row.sourceCheckout===undefined||typeof row.sourceCheckout==='string'&&path.isAbsolute(row.sourceCheckout))))throw failure('SERVICE_PROJECT_CONFIGURATION_INVALID');
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
