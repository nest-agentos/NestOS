import {expect,it} from 'vitest';
import {kanbanConfigurationDefaults} from '../src/resources/catalog';
import {promptReferenceSections} from '../src/run/prompt-reference-sections';
import {hasMarkdownSection} from '../src/run/prompt-bundle';
import {channelInstruction} from '../src/presets/kanban-development';
import {maintenanceInstruction} from '../src/presets/kanban-maintenance';
const files=Object.entries(kanbanConfigurationDefaults).map(([name,content])=>({name,content,sha256:'frozen',source:'fixture'}));
it('discloses a short decision entry while retaining its protocol for a later scoped read',()=>{
 const sections=promptReferenceSections(files,'decision-propose.md');
 expect(Buffer.byteLength(sections['decision-propose.md'])).toBeLessThan(800);
 expect(sections['decision-propose.md']).not.toContain('decision.apply-edit');
 expect(sections['decision-actions.md']).toContain('decision.apply-edit');
 expect(sections['session-protocol.md']).toContain('replyTo');
 expect(Object.keys(sections).sort()).toEqual(['decision-actions.md','decision-propose.md','session-protocol.md']);
 expect(sections).not.toHaveProperty('task.md');expect(sections).not.toHaveProperty('operation.md');
});
it('keeps custom Markdown references bounded and immutable even with cycles',()=>{
 const custom=[{name:'entry.md',content:'Read `guide.md` and README.md.'},{name:'guide.md',content:'Read `entry.md` when needed.'},{name:'unused.md',content:'Unrelated private task'}].map(file=>({...file,source:'project',sha256:'frozen'}));
 const before=JSON.stringify(custom),sections=promptReferenceSections(custom,'entry.md');
 expect(Object.keys(sections).sort()).toEqual(['entry.md','guide.md']);expect(sections['guide.md']).toBe(custom[1].content);expect(JSON.stringify(custom)).toBe(before);
});
it('loads the task entry before workspace and delivery manuals and preserves host terminal hooks',()=>{
 const bootstrap=channelInstruction({commit:'changes',prompts:{files}} as never,'task.md',[]);
 expect(bootstrap).toContain('identity, instructions, task.md');expect(bootstrap).not.toContain('identity, policy');
 expect(bootstrap).not.toContain('policy.gitIdentity');expect(bootstrap.length).toBeLessThan(400);
 expect(kanbanConfigurationDefaults['task.md']).toContain('workspace-rules.md');
 for(const stage of ['postload.failed','postload.cancelled','cleanup'])expect(hasMarkdownSection(kanbanConfigurationDefaults['task.md'],stage)).toBe(true);
});
it.each(['analyze','build','deploy','merge'] as const)('starts %s with one Markdown entry and defers result instructions',action=>{
 const text=maintenanceInstruction(action);expect(Buffer.byteLength(text)).toBeLessThan(100);
 expect(text).toContain('-pre.md');expect(text).not.toContain('-post.md');expect(text).not.toContain('operation-result.md');expect(text.startsWith('{')).toBe(false);
});
it.each(['task.md', 'task-merge-post.md', 'operation-result.md'])('makes the concise learning contract reachable from %s', entry => {
 const sections = promptReferenceSections(files, entry);
 expect(sections['session-learnings.md']).toContain('payload.learnings');
 expect(sections['session-learnings.md']).toContain('formally associated Task IDs');
 expect(sections['session-learnings.md'].split(/\s+/).length).toBeLessThan(90);
});
