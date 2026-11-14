import {expect,it,vi} from 'vitest';
import {readStartup} from '../src/host/startup-read';
function fixture() {
 const eventBaseline=vi.fn(async()=>({streamId:'events',sequence:1})),readUiDocuments=vi.fn(async()=>({theme:'dark'})),decisionSnapshot=vi.fn(async()=>({observedAt:2}));
 return {backend:{events:{eventBaseline},readUiDocuments} as never,services:{kanban:{decisionSnapshot}} as never,eventBaseline,readUiDocuments,decisionSnapshot};
}
it('captures the event watermark first and starts only requested independent sources concurrently',async()=>{
 const f=fixture();let finish!:(value:Record<string,unknown>)=>void;
 f.readUiDocuments.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=readStartup(f.backend,f.services,{eventBaseline:true,documents:['theme'],decision:{boardId:'b',query:{sections:['page']}}});
 await vi.waitFor(()=>expect(f.decisionSnapshot).toHaveBeenCalledOnce());expect(f.eventBaseline).toHaveBeenCalledOnce();
 expect(f.eventBaseline.mock.invocationCallOrder[0]).toBeLessThan(f.decisionSnapshot.mock.invocationCallOrder[0]);finish({theme:'dark'});
 expect(await pending).toMatchObject({eventBaseline:{value:{sequence:1}},documents:{value:{theme:'dark'}},decision:{value:{observedAt:2}}});
 const other=fixture();await readStartup(other.backend,other.services,{documents:['theme']});expect(other.eventBaseline).not.toHaveBeenCalled();expect(other.decisionSnapshot).not.toHaveBeenCalled();
});
it('preserves a denied section without hiding independent results or leaking private errors',async()=>{
 const f=fixture(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  f.decisionSnapshot.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'),{code:'FORBIDDEN'}));
  const result=await readStartup(f.backend,f.services,{documents:['theme'],decision:{boardId:'b',query:{}}});
  expect(result.decision).toEqual({code:'FORBIDDEN'});expect(result.documents).toEqual({value:{theme:'dark'}});
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_BODY');expect(warn).toHaveBeenCalledWith('[ApplicationRead]',expect.objectContaining({operationId:expect.any(String),stage:'decision',result:'failure',code:'FORBIDDEN',durationMs:expect.any(Number)}));
 }finally{warn.mockRestore();}
});
