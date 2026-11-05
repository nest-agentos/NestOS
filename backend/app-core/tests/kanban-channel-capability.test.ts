import {expect,it,vi} from 'vitest';
import {developmentPreparation} from '../src/presets/kanban-development';
it.each([
    [{workingDirectory:false,sessionChannels:true},'NATIVE_WORKING_DIRECTORY_UNSUPPORTED'],
    [{workingDirectory:true,sessionChannels:false},'NATIVE_SESSION_CHANNEL_REQUIRED'],
])('rejects missing execution capabilities before creating workspaces: %s',async(capabilities,code)=>{
    const target={kind:'agent',id:'worker',version:'1',digest:'a'.repeat(64)},close=vi.fn(async()=>{}),openWorkspace=vi.fn();
    const prepare=developmentPreparation({fs:{},provider:{},agents:{getAgentRevision:async()=>({target,definition:{config:{},execution:{kind:'harness',connectionId:'template'}}})},
        connections:{get:async()=>({connection:{profileId:'native'}})},projects:{get:vi.fn(),openWorkspace},remote:{projectHarness:async()=>({profiles:async()=>({profiles:[{id:'native',capabilities}]}),close})}} as never);
    await expect(prepare({target,preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'},item:{externalRefs:[{system:'nestos-remote-project',id:'project'}]},dispatch:{id:'attempt'}} as never)).rejects.toMatchObject({code});
    expect(close).toHaveBeenCalledOnce();expect(openWorkspace).not.toHaveBeenCalled();
});
