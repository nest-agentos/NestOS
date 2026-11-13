import {createModuleLogger} from '@nestos/common';
import type {GitProcess} from '@nestos/git-delivery/contracts';
import {gitWorkspace} from '@nestos/git-delivery/repositories';
const log=createModuleLogger('kanban');
interface Package {scripts?:{build?:string};packageManager?:string;dependencies?:unknown;devDependencies?:unknown;optionalDependencies?:unknown;main?:unknown;module?:unknown;types?:unknown;bin?:unknown;exports?:unknown}
/** Only package-owned dependency trees and declared build outputs are disposable. */
export async function removableDevelopmentArtifacts(process:GitProcess,directory:string,paths:readonly string[],operationId?:string):Promise<string[]> {
    const started=Date.now();
    const safe=paths.filter(path=>path.endsWith('/')&&path.slice(0,-1).split('/').every(part=>/^[a-zA-Z0-9_.@-]+$/.test(part)&&part!=='.'&&part!=='..'));
    const names=[...new Set(safe.map(path=>path.slice(0,-1).split('/').slice(0,-1).join('/')))];if(!names.length)return [];
    if(names.length>200)return [];
    const candidates=names.map(name=>(name?name+'/':'')+'package.json');
    const listing=await gitWorkspace(process,directory,['ls-tree','-r','HEAD','--',...candidates]);
    const files=listing.stdout.split('\n').flatMap(line=>{const match=/^100(?:644|755) blob [a-f0-9]+\t(.+)$/.exec(line);return match&&candidates.includes(match[1])?[match[1]]:[];});if(!files.length)return [];
    const content=await gitWorkspace(process,directory,['show',...files.map(path=>'HEAD:'+path)]);
    const values=content.stdout.length<=1024*1024?packageDocuments(content.stdout):[];
    if(values.length!==files.length){log.warn('Generated artifact classification unavailable',{operation:'software.cleanup.classify',operationId,stage:'manifest',result:'failure',code:'GENERATED_ARTIFACT_MANIFEST_INVALID',count:files.length,durationMs:Date.now()-started});return [];}
    const manifests=new Map(files.map((file,index)=>[file.slice(0,-'package.json'.length).replace(/\/$/,''),values[index]]));
    const approved=safe.filter(path=>{const parts=path.slice(0,-1).split('/'),name=parts.pop()!,manifest=manifests.get(parts.join('/'));
        if(!manifest)return false;
        if(name==='node_modules')return !!(manifest.packageManager||manifest.dependencies||manifest.devDependencies||manifest.optionalDependencies);
        return !!manifest.scripts?.build&&['dist','build','lib','dist-server','dist-ui'].includes(name)&&referencesOutput(manifest,name);
    });
    if(operationId)log.debug('Generated artifacts classified',{operation:'software.cleanup.classify',operationId,stage:'manifest',result:'success',count:paths.length,approved:approved.length,retained:paths.length-approved.length,durationMs:Date.now()-started});
    return approved;
}
function referencesOutput(manifest:Package,name:string):boolean {
    const references=(value:unknown):boolean=>typeof value==='string'?value.replace(/^\.\//,'').startsWith(name+'/'):
        !!value&&typeof value==='object'&&Object.values(value).some(references);
    return [manifest.main,manifest.module,manifest.types,manifest.bin,manifest.exports].some(references)
        ||new RegExp('(?:--out-dir|--outDir|--outdir)(?:=| +)["\\\']?'+name+'(?:["\\\']| |$)').test(manifest.scripts?.build??'');
}

/** Git emits consecutive blob contents; retain bounded JSON objects without shell interpolation. */
function packageDocuments(text:string):Package[] {
    const values:Package[]=[];let depth=0,start=0,quoted=false,escape=false;
    try{for(let index=0;index<text.length;index++){
        const character=text[index];
        if(!depth){if(/\s/.test(character))continue;if(character!=='{')return [];start=index;}
        if(quoted){if(escape)escape=false;else if(character==='\\')escape=true;else if(character==='"')quoted=false;continue;}
        if(character==='"')quoted=true;else if(character==='{')depth++;else if(character==='}'&&!--depth)values.push(JSON.parse(text.slice(start,index+1)));
    }}catch{return [];}
    return depth||quoted?[]:values;
}
