import {describe,expect,it,vi} from 'vitest';
import {sha256HexSync} from '@nestos/llm-context';
import {McpSkillVerification,type McpSkillEntry} from './mcp-skill-verification';
const uri='skill://example/SKILL.md',support='skill://example/reference.md';
const bytes=(text:string)=>new TextEncoder().encode(text);
const main=bytes('---\nname: example\ndescription: Example\nmetadata:\n  version: one\n---\nBody\n');
const ref=bytes('reference');
const item=(uri:string,value:Uint8Array)=>({uri,digest:'sha256:'+sha256HexSync(value),size:value.length});
const entry=():McpSkillEntry=>({uri,frontmatter:{name:'example',description:'Example',metadata:{version:'one'}},resources:[item(uri,main),item(support,ref)]});

describe('MCP skill verification',()=>{
 it('reads only on approved activation and requests supporting files on demand',async()=>{
  const read=vi.fn(async(path:string)=>path===uri?main:ref),verify=new McpSkillVerification('server-a',entry(),{read});
  await expect(verify.read(support)).rejects.toThrow('MCP_SKILL_APPROVAL_REQUIRED');expect(read).not.toHaveBeenCalled();
  await expect(verify.load(async()=>false)).rejects.toThrow('MCP_SKILL_APPROVAL_DENIED');expect(read).not.toHaveBeenCalled();
  await verify.load(async(server,held)=>server==='server-a'&&held.uri===uri);expect(read).toHaveBeenCalledTimes(1);
  await verify.read(support);expect(read).toHaveBeenCalledTimes(2);
  await expect(verify.read('skill://example/private.md')).rejects.toThrow('MCP_SKILL_RESOURCE_UNAUTHORIZED');expect(read).toHaveBeenCalledTimes(2);
 });
 it('rejects altered bytes and frontmatter, and revokes access after failure',async()=>{
  const bad=new McpSkillVerification('server',entry(),{read:async()=>bytes('wrong')});
  await expect(bad.load(async()=>true)).rejects.toThrow('MCP_SKILL_SIZE_MISMATCH');
  await expect(bad.read(support)).rejects.toThrow('MCP_SKILL_APPROVAL_REQUIRED');
  const metadata=entry();metadata.frontmatter.description='Changed';
  await expect(new McpSkillVerification('server',metadata,{read:async()=>main}).load(async()=>true)).rejects.toThrow('MCP_SKILL_FRONTMATTER_MISMATCH');
  const altered=new Uint8Array(main);altered[altered.length-2]^=1;
  await expect(new McpSkillVerification('server',entry(),{read:async()=>altered}).load(async()=>true)).rejects.toThrow('MCP_SKILL_DIGEST_MISMATCH');
 });
 it('rejects duplicated and foreign manifests before reads',()=>{
  const port={read:vi.fn()},duplicate=entry(),foreign=entry();
  (duplicate.resources as any[]).push((duplicate.resources as any[])[0]);
  (foreign.resources as any[])[1].uri='skill://other/reference.md';
  for(const value of [duplicate,foreign])expect(()=>new McpSkillVerification('server',value,port)).toThrow();
  expect(port.read).not.toHaveBeenCalled();
 });
 it('verifies dynamic frontmatter and does not grant subsequent resource access',async()=>{
  const read=vi.fn(async()=>main),value={...entry(),resources:'dynamic' as const};
  const verifier=new McpSkillVerification('server',value,{read});
  await expect(verifier.load(async()=>false)).rejects.toThrow('MCP_SKILL_APPROVAL_DENIED');
  expect(read).not.toHaveBeenCalled();
  await expect(verifier.load(async()=>true)).resolves.toContain('Body');
  await expect(verifier.read(uri)).rejects.toThrow('MCP_SKILL_RESOURCE_UNAUTHORIZED');
  await expect(verifier.read(support)).rejects.toThrow('MCP_SKILL_RESOURCE_UNAUTHORIZED');
  expect(read.mock.calls).toEqual([[uri]]);
  read.mockResolvedValue(bytes('---\nname: example\ndescription: Different\n---\n'));
  await expect(verifier.load(async()=>true)).rejects.toThrow('MCP_SKILL_FRONTMATTER_MISMATCH');
 });
 it('revokes pending activation and in-flight supporting reads',async()=>{
  let accept!:(allowed:boolean)=>void;
  const verify=new McpSkillVerification('server',entry(),{read:async path=>path===uri?main:ref});
  const pending=verify.load(()=>new Promise(resolve=>{accept=resolve;}));
  verify.revoke();accept(true);await expect(pending).rejects.toThrow('MCP_SKILL_APPROVAL_REVOKED');
  await expect(verify.read(support)).rejects.toThrow('MCP_SKILL_APPROVAL_REQUIRED');
  let finish!:(bytes:Uint8Array)=>void;
  const delayed=new McpSkillVerification('server',entry(),{read:path=>path===uri?Promise.resolve(main):new Promise(resolve=>{finish=resolve;})});
  await delayed.load(async()=>true);const reading=delayed.read(support);delayed.revoke();finish(ref);
  await expect(reading).rejects.toThrow('MCP_SKILL_APPROVAL_REVOKED');
  await expect(delayed.read(support)).rejects.toThrow('MCP_SKILL_APPROVAL_REQUIRED');
 });
});
