// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {NAVIGATION_EVENTS,t} from '@nestos/common';
import {beginNavigationTiming} from '../src/navigation/navigation-timing';
import {loadStudyPrompts} from '../src/browser/study-prompts';

afterEach(()=>vi.restoreAllMocks());
it('reports only slow or failed navigation to the existing metadata diagnostic port',()=>{
 let time=0;vi.spyOn(performance,'now').mockImplementation(()=>time);
 const report=vi.fn();
 beginNavigationTiming(true,report)('success');expect(report).not.toHaveBeenCalled();
 const slow=beginNavigationTiming(false,report);time=1500;slow('success');
 expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({operation:'navigation.performance',code:'NAVIGATION_SLOW',durationMs:1500,result:'failure'}));
 const ignored=beginNavigationTiming(false,report);time=3000;ignored('superseded');expect(report).toHaveBeenCalledTimes(1);
 beginNavigationTiming(false,report)('failure');expect(report).toHaveBeenLastCalledWith(expect.objectContaining({code:'NAVIGATION_FAILED'}));
 expect(()=>beginNavigationTiming(false,()=>{throw Error('PRIVATE_BODY');})('failure')).not.toThrow();
});
it('keeps overlapping navigation operations distinct and reports supersession without resource paths',()=>{
 const starts:any[]=[],ends:any[]=[];
 const start=(event:Event)=>starts.push((event as CustomEvent).detail),end=(event:Event)=>ends.push((event as CustomEvent).detail);
 window.addEventListener(NAVIGATION_EVENTS.START,start);window.addEventListener(NAVIGATION_EVENTS.END,end);
 try{
  const first=beginNavigationTiming(false),second=beginNavigationTiming(true);first('superseded');second('success');
  expect(starts[0].operationId).not.toBe(starts[1].operationId);
  expect(ends).toEqual([expect.objectContaining({operationId:starts[0].operationId,result:'superseded',cached:false}),expect.objectContaining({operationId:starts[1].operationId,result:'success',cached:true})]);
  expect(ends.every(row=>row.durationMs>=0&&!('resourceId' in row))).toBe(true);
 }finally{window.removeEventListener(NAVIGATION_EVENTS.START,start);window.removeEventListener(NAVIGATION_EVENTS.END,end);}
});
it('keeps prompt failures actionable without exposing their body and permits a later retry',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const backend={studyPromptPresets:vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'),{code:'EACCES'})).mockResolvedValue([])};
 await expect(loadStudyPrompts(backend)).rejects.toMatchObject({code:'EACCES',message:t('editor.studyPromptsUnavailable')});
 expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_BODY');
 await expect(loadStudyPrompts(backend)).resolves.toEqual({presets:[]});
});
