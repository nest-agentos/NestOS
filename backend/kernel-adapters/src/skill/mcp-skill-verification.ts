import {JSON_SCHEMA,load as loadYaml} from 'js-yaml';
import {sha256HexSync} from '@nestos/llm-context';

export interface McpSkillResource {uri:string;digest:string;size:number}
export interface McpSkillEntry {uri:string;frontmatter:Record<string,unknown>;resources:McpSkillResource[]|'dynamic'}
export interface McpSkillPort {read(uri:string):Promise<Uint8Array>}

export function mcpSkillManifestDigest(entry:McpSkillEntry):string {
    validateManifest(entry);
    if(entry.resources==='dynamic')return 'sha256:'+sha256HexSync(canonical({uri:entry.uri,frontmatter:entry.frontmatter,resources:'dynamic'}));
    const files=entry.resources.map(({uri,digest,size})=>({uri,digest,size})).sort((a,b)=>a.uri<b.uri?-1:a.uri>b.uri?1:0);
    return 'sha256:'+sha256HexSync(canonical({uri:entry.uri,frontmatter:entry.frontmatter,resources:files}));
}

export function sameMcpSkillEntry(a:McpSkillEntry,b:McpSkillEntry):boolean {
    return mcpSkillManifestDigest(a)===mcpSkillManifestDigest(b);
}

export async function readMcpSkillFile(entry:McpSkillEntry,uri:string,port:McpSkillPort):Promise<Uint8Array> {
    const resource=Array.isArray(entry.resources)&&entry.resources.find(file=>file.uri===uri);
    if(!resource)throw new Error('MCP_SKILL_RESOURCE_UNAUTHORIZED');
    const bytes=await port.read(uri);
    if(bytes.byteLength!==resource.size)throw new Error('MCP_SKILL_SIZE_MISMATCH');
    if('sha256:'+sha256HexSync(bytes)!==resource.digest)throw new Error('MCP_SKILL_DIGEST_MISMATCH');
    return bytes;
}

/** A held entry is tied to a host-assigned server and never fetches another origin. */
export class McpSkillVerification {
    private readonly entry:McpSkillEntry;
    private approved=false;
    private generation=0;
    constructor(readonly serverId:string,entry:McpSkillEntry,private readonly port:McpSkillPort) {
        if(!serverId)throw new Error('MCP_SKILL_SERVER_REQUIRED');
        validateManifest(entry);
        this.entry=structuredClone(entry);
    }
    async load(approve:(serverId:string,entry:McpSkillEntry)=>Promise<boolean>):Promise<string> {
        const generation=++this.generation;this.approved=false;
        if(!await approve(this.serverId,structuredClone(this.entry)))throw new Error('MCP_SKILL_APPROVAL_DENIED');
        if(generation!==this.generation)throw new Error('MCP_SKILL_APPROVAL_REVOKED');
        try {
            const bytes=await this.fetchVerified(this.entry.uri);
            const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
            const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
            if(!match||canonical(loadYaml(match[1],{schema:JSON_SCHEMA}))!==canonical(this.entry.frontmatter))throw new Error('MCP_SKILL_FRONTMATTER_MISMATCH');
            if(generation!==this.generation)throw new Error('MCP_SKILL_APPROVAL_REVOKED');
            this.approved=true;return text;
        } catch(error) {if(generation===this.generation)this.approved=false;throw error;}
    }
    revoke():void {this.generation++;this.approved=false;}
    async read(uri:string):Promise<Uint8Array> {
        if(!this.approved)throw new Error('MCP_SKILL_APPROVAL_REQUIRED');
        if(this.entry.resources==='dynamic')throw new Error('MCP_SKILL_RESOURCE_UNAUTHORIZED');
        const generation=this.generation;
        try {const bytes=await this.fetchVerified(uri);if(generation!==this.generation)throw new Error('MCP_SKILL_APPROVAL_REVOKED');return bytes;}
        catch(error) {if(generation===this.generation)this.approved=false;throw error;}
    }
    private async fetchVerified(uri:string):Promise<Uint8Array> {
        if(this.entry.resources==='dynamic') {
            if(uri!==this.entry.uri)throw new Error('MCP_SKILL_RESOURCE_UNAUTHORIZED');
            const bytes=await this.port.read(uri);
            if(bytes.byteLength>16*1024*1024)throw new Error('MCP_SKILL_LIMIT');
            return bytes;
        }
        return readMcpSkillFile(this.entry,uri,this.port);
    }
}

function validateManifest(entry:McpSkillEntry):void {
    const resources=entry.resources,seen=new Set<string>();
    let root:string;
    try {const url=new URL(entry.uri),parts=url.pathname.split('/').filter(Boolean);
        if(url.href!==entry.uri||url.search||url.hash||!url.pathname.endsWith('/SKILL.md')||entry.frontmatter.name!==(parts.length>1?parts[parts.length-2]:url.hostname)
            ||typeof entry.frontmatter.description!=='string'||!entry.frontmatter.description)throw 0;root=new URL('.',url).href;}
    catch {throw new Error('MCP_SKILL_MANIFEST_INVALID');}
    if(resources==='dynamic')return;
    if(!Array.isArray(resources))throw new Error('MCP_SKILL_MANIFEST_INVALID');
    if(resources.length>512)throw new Error('MCP_SKILL_LIMIT');
    let total=0;
    for(const file of resources) {
        let uri:URL;try{uri=new URL(file.uri);}catch{throw new Error('MCP_SKILL_MANIFEST_INVALID');}
        if(uri.href!==file.uri||uri.search||uri.hash||!file.uri.startsWith(root)||seen.has(file.uri)||!Number.isSafeInteger(file.size)||file.size<0||!/^sha256:[a-f0-9]{64}$/.test(file.digest))throw new Error('MCP_SKILL_MANIFEST_INVALID');
        total+=file.size;
        if(total>16*1024*1024)throw new Error('MCP_SKILL_LIMIT');
        seen.add(file.uri);
    }
    if(!seen.has(entry.uri))throw new Error('MCP_SKILL_MANIFEST_INVALID');
}
function canonical(value:unknown):string {
    const normalize=(input:unknown):unknown=>Array.isArray(input)?input.map(normalize):input&&typeof input==='object'
        ?Object.fromEntries(Object.entries(input).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,normalize(item)])):input;
    return JSON.stringify(normalize(value));
}
