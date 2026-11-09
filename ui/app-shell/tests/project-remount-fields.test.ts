// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {projectRemountFields,remountFailure} from '../src/projects/project-remount-fields';
import type {ProjectRemoteMount,ProjectRemoteMountPort} from '@nestos/app-contracts/services';
const root={alias:'old',root:'/',access:'rw'} as ProjectRemoteMount;
it('offers new exports and a relative directory even when the old alias is absent',async()=>{
 const remote={projectRemountOptions:vi.fn(async()=>({alias:'old',path:'',roots:[{alias:'prj',access:'rw'}]}))} as unknown as ProjectRemoteMountPort;
 const fields=await projectRemountFields(remote,'x1',root,new AbortController().signal);
 expect(()=>fields.directory()).toThrow();
 const select=fields.panel.querySelectorAll('select')[1],input=fields.panel.querySelector('input')!;
 select.value='prj';input.value=' /x1/ ';
 expect(fields.directory()).toEqual({alias:'prj',path:'x1'});expect(fields.access()).toBe('rw');
});
it('retains access-only remount for older Cells nodes and preserves transport failures',async()=>{
 const remote={projectRemountOptions:vi.fn().mockRejectedValue(Object.assign(new Error('Old node'),{code:'ECAPABILITY'}))} as unknown as ProjectRemoteMountPort;
 const fields=await projectRemountFields(remote,'x1',root,new AbortController().signal);
 expect(fields.directory()).toBeUndefined();expect(fields.panel.querySelector('input')!.disabled).toBe(true);
 vi.mocked(remote.projectRemountOptions).mockRejectedValueOnce(new Error('Offline'));
 await expect(projectRemountFields(remote,'x1',root,new AbortController().signal)).rejects.toThrow('Offline');
});

it('retains diagnostic codes while explaining directory mismatch and stale revisions',()=>{
 for(const code of ['PROJECT_DIRECTORY_ALREADY_REGISTERED','PROJECT_DIRECTORY_CHANGED','PROJECT_REVISION_CHANGED','EBUSY']){
  const original=Object.assign(new Error(code),{code:'EIO',remoteCode:code}),mapped=remountFailure(original) as Error;
  expect(mapped).not.toBe(original);expect(mapped.cause).toBe(original);expect(mapped).toMatchObject({remoteCode:code});
 }
 const unknown=new Error('Offline');expect(remountFailure(unknown)).toBe(unknown);
});
