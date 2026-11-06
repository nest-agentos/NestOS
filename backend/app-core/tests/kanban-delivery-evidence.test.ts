import {expect,it} from 'vitest';
import {recordDeliveryEvidence} from '../src/presets/kanban-development-delivery';
import type {PromptJournal} from '../src/run/prompt-bundle';
it('preserves earlier delivery evidence and records each reverified revision exactly once',async()=>{
 const records=new Map<string,unknown>();
 const journal={update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const next=change(records.get(key) as T|undefined);records.set(key,next);return next;}} as PromptJournal;
 const original={verifiedAt:1,repositories:[{head:'old'}]};records.set('development-delivery:dispatch',original);
 const repo={path:'.',branch:'work/task',baseCommit:'base',head:'first',dirty:false,changesDigest:'clean'};
 await recordDeliveryEvidence(journal,'dispatch','worktree',[repo]);
 const first=[...records.entries()].find(([key])=>key!=='development-delivery:dispatch')!;
 await recordDeliveryEvidence(journal,'dispatch','worktree',[repo]);
 expect(records.size).toBe(2);expect(records.get(first[0])).toBe(first[1]);
 await recordDeliveryEvidence(journal,'dispatch','worktree',[{...repo,head:'rebuilt'}]);
 expect(records.size).toBe(3);expect(records.get('development-delivery:dispatch')).toBe(original);
 expect([...records.values()]).toContainEqual(expect.objectContaining({commit:'worktree',repositories:[expect.objectContaining({head:'rebuilt'})]}));
});
