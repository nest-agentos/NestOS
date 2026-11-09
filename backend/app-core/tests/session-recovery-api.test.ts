import {expect,it,vi} from 'vitest';
import {FSError} from '@nestos/vfs-core';
import type {NativeSessionRecoveryRequest} from '@nestos/app-contracts/services';
import {NativeSessionRecovery} from '../src/projects/session-recovery';
const request:NativeSessionRecoveryRequest={projectId:'p',profileId:'codex',sessionId:'native',operationId:'recovery',instructionId:'old',expectedRevision:7};
function fixture(){
    const response={session:{id:'native',title:'Native',status:'notLoaded',owned:false,loaded:false,cwd:null,updatedAt:null,resumable:true},operationId:'recovery',outcome:'recovered' as const,duplicate:false,
        queue:{revision:8,paused:true,items:[],receipts:[],recoveries:[]}};
    const forward=vi.fn(async()=>response);
    const conversation=vi.fn(()=>{throw new Error('No application conversation may be opened');});
    const remote={nativeSessionRecovery:forward,projectConversation:conversation};
    return {forward,conversation,response,service:new NativeSessionRecovery(()=>remote)};
}
it('forwards inspect and recovery to Cells without opening an application conversation or local journal',async()=>{
    const f=fixture();expect(await f.service.inspect(request)).toMatchObject({sessionId:'native'});
    expect(await f.service.recover(request)).toMatchObject({operationId:'recovery',outcome:'recovered' as const,duplicate:false,state:{instructionQueue:{revision:8}}});
    expect(f.forward).toHaveBeenLastCalledWith(request,request);expect(f.conversation).not.toHaveBeenCalled();await f.service.close();
});
it('preserves authoritative duplicate results and never decides recovery from a NestOS cache',async()=>{
    const f=fixture();f.response.duplicate=true;
    const results=await Promise.all([f.service.recover(request),f.service.recover(request)]);
    expect(results.every(result=>result.duplicate)).toBe(true);expect(f.forward).toHaveBeenCalledTimes(2);await f.service.close();
});
it('propagates node conflicts and unknown outcomes without creating replacement operations',async()=>{
    const f=fixture();f.forward.mockRejectedValueOnce(Object.assign(new FSError('ECONFLICT','native revision changed'),{remoteCode:'HARNESS_RECOVERY_QUEUE_CHANGED',outcome:'not-committed'}));
    await expect(f.service.recover(request)).rejects.toMatchObject({remoteCode:'HARNESS_RECOVERY_QUEUE_CHANGED'});
    f.forward.mockRejectedValueOnce(Object.assign(new FSError('EIO','connection lost'),{outcome:'unknown'}));
    await expect(f.service.recover(request)).rejects.toMatchObject({outcome:'unknown'});expect(f.forward).toHaveBeenCalledTimes(2);await f.service.close();
});
it('drains admitted requests during shutdown and rejects new work',async()=>{
    const f=fixture(),work=f.service.recover(request),closed=f.service.close();await expect(work).resolves.toMatchObject({outcome:'recovered'});await closed;
    await expect(f.service.recover(request)).rejects.toMatchObject({code:'EBUSY'});expect(f.forward).toHaveBeenCalledOnce();
});
