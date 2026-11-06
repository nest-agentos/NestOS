import type {PromptJournal} from '../run/prompt-bundle';
import {createModuleLogger} from '@nestos/common';
interface Entry {review:string[];lifecycle:string[];complete:boolean}
const key=(id:string)=>'work-resource-jobs:'+id;
export async function initializeResourceIndex(journal:PromptJournal,id:string):Promise<void> {
    await journal.update<Entry>(key(id),old=>old??{review:[],lifecycle:[],complete:true});
}
export async function indexResourceJob(journal:PromptJournal,id:string,kind:'review'|'lifecycle',job:string):Promise<void> {
    await journal.update<Entry>(key(id),old=>{const value=old??{review:[],lifecycle:[],complete:false};return value[kind].includes(job)?value:{...value,[kind]:[...value[kind],job]};});
}
/** Associations are derived; every operation's current state is still read from its sole journal record. */
export async function resourceJobIndex(journal:PromptJournal,id:string,discover:()=>Promise<{review:string[];lifecycle:string[]}>):Promise<Entry> {
    const saved=await journal.get<Entry>(key(id));if(saved?.complete)return saved;
    const started=Date.now(),review:string[]=[],lifecycle:string[]=[];
    const found=await discover();review.push(...found.review);lifecycle.push(...found.lifecycle);
    const result=await journal.update<Entry>(key(id),old=>({complete:true,review:[...new Set([...old?.review??[],...review])],lifecycle:[...new Set([...old?.lifecycle??[],...lifecycle])]}));
    createModuleLogger('kanban-worktree').info('Resource association index rebuilt',{operation:'kanban.worktree.index',operationId:id,stage:'rebuild',result:'success',reviewCount:result.review.length,lifecycleCount:result.lifecycle.length,durationMs:Date.now()-started});return result;
}
