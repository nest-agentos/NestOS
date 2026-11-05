// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {ModelConfigurationCommands} from '@nestos/app-core';
import {ConfigurationDeletionDialog} from '../src/configuration/delete-dialog';
afterEach(()=>{document.body.innerHTML='';});
function fixture(){
    const store={getProviders:()=>[],getConnections:async()=>[],getMCPServers:async()=>[{id:'office',name:'Office server'}],
        deleteProvider:vi.fn(),deleteConnection:vi.fn(),deleteMCPServer:vi.fn(),deleteSystemPrompt:vi.fn()};
    const commands=new ModelConfigurationCommands(store),dialog=new ConfigurationDeletionDialog(commands);
    return {store,commands,dialog};
}
it('confirms MCP removal by name without offering Cells project deletion',async()=>{
    const {store,commands,dialog}=fixture();
    const result=dialog.requestResult([{kind:'entity',entityType:'mcp',id:'office'}]);
    await vi.waitFor(()=>expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    expect(document.body.textContent).toContain('Office server');expect(document.querySelector('input[type=checkbox]')).toBeNull();
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    expect(await result).toBe('completed');expect(store.deleteMCPServer).toHaveBeenCalledWith('office');await commands.dispose();
});
it('cancelling preserves the MCP configuration',async()=>{
    const {store,commands,dialog}=fixture();
    const result=dialog.requestResult([{kind:'entity',entityType:'mcp',id:'office'}]);
    await vi.waitFor(()=>expect(document.querySelector('.settings-modal-cancel')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    expect(await result).toBe('cancelled');expect(store.deleteMCPServer).not.toHaveBeenCalled();await commands.dispose();
});
