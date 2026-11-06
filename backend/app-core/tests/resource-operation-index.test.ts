import{expect,it,vi}from'vitest';
import{initializeResourceIndex,indexResourceJob,resourceJobIndex}from'../src/kanban/resource-operation-index';
function fixture(){const records=new Map<string,any>();return {get:vi.fn(async(key:string)=>records.get(key)),update:vi.fn(async(key:string,change:any)=>{const value=change(records.get(key));records.set(key,value);return value;})} as any;}
it('uses a newborn resource index without scanning unrelated history and deduplicates association writes',async()=>{
 const journal=fixture(),discover=vi.fn(async()=>({review:['unrelated'],lifecycle:[]}));await initializeResourceIndex(journal,'tree');
 await indexResourceJob(journal,'tree','review','operation');await indexResourceJob(journal,'tree','review','operation');
 expect(await resourceJobIndex(journal,'tree',discover)).toEqual({complete:true,review:['operation'],lifecycle:[]});expect(discover).not.toHaveBeenCalled();
});
it('recovers retained associations once while preserving concurrently registered jobs',async()=>{
 const journal=fixture();await indexResourceJob(journal,'old','review','new');
 const discover=vi.fn(async()=>{await indexResourceJob(journal,'old','lifecycle','concurrent-hook');return {review:['retained'],lifecycle:['retained-hook']};});
 const index=await resourceJobIndex(journal,'old',discover);expect(index.review).toEqual(['new','retained']);expect(index.lifecycle).toEqual(['concurrent-hook','retained-hook']);
 await resourceJobIndex(journal,'old',discover);expect(discover).toHaveBeenCalledOnce();
});
it('never seals a failed recovery as an empty complete index',async()=>{
 const journal=fixture();await expect(resourceJobIndex(journal,'old',async()=>{throw Error('Read failed');})).rejects.toThrow('Read failed');
 expect((await resourceJobIndex(journal,'old',async()=>({review:['active'],lifecycle:[]}))).review).toEqual(['active']);
});
