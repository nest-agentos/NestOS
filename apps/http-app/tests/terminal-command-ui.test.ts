// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest';
import {CommandPanel} from '../../../libraries/terminal-ui/src/commands';
import {TerminalWidget} from '../../../libraries/terminal-ui/src/index';

describe('terminal command controls', () => {
    it('lists text safely and selects history without requesting execution', async () => {
        const root=document.createElement('div'),insert=vi.fn(),error=vi.fn();
        const storage={listHistory:vi.fn(async()=>['echo <value>']),listCommands:vi.fn(async()=>[]),saveCommand:vi.fn(),deleteCommand:vi.fn()};
        const panel=new CommandPanel(root,storage,key=>key,()=> 'id',insert,error);
        await panel.show('history');const buttons=root.querySelectorAll('button');expect(buttons[1]!.textContent).toBe('echo <value>');
        expect(root.querySelector('value')).toBeNull();buttons[1]!.click();expect(insert).toHaveBeenCalledWith('echo <value>',false);expect(error).not.toHaveBeenCalled();
    });
    it('inserts history without Enter and only sends Enter for an explicit command action', () => {
        const root=document.createElement('div'),widget=new TerminalWidget(root,undefined,key=>key) as any;
        const paste=vi.fn(),focus=vi.fn(),enqueue=vi.fn();widget.active=true;widget.terminal={modes:{bracketedPasteMode:true},paste,focus};widget.enqueueInput=enqueue;
        widget.insertCommand('echo test',false);expect(paste).toHaveBeenCalledWith('echo test');expect(enqueue).not.toHaveBeenCalled();
        widget.insertCommand('echo test',true);expect(enqueue).toHaveBeenCalledWith('\r');
        widget.insertCommand('bad\x1b[201~\r',false);expect(paste).toHaveBeenCalledTimes(2);
    });
    it('creates, edits, deletes and invokes saved commands', async () => {
        const root=document.createElement('div'),insert=vi.fn(),error=vi.fn();
        let rows:Array<{id:string;name:string;command:string}>=[];
        const storage={listHistory:vi.fn(async()=>[]),listCommands:vi.fn(async()=>rows),
            saveCommand:vi.fn(async(row:{id:string;name:string;command:string})=>{rows=[row];}),deleteCommand:vi.fn(async()=>{rows=[];})};
        const panel=new CommandPanel(root,storage,key=>key,()=> 'stable-id',insert,error);await panel.show('commands');
        root.querySelector('input')!.value='Name';root.querySelector('textarea')!.value='echo first';
        root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        await vi.waitFor(()=>expect(rows).toEqual([{id:'stable-id',name:'Name',command:'echo first'}]));
        await vi.waitFor(()=>expect(root.querySelectorAll('button').length).toBeGreaterThan(2));
        [...root.querySelectorAll('button')].find(button=>button.textContent==='Name')!.click();expect(insert).toHaveBeenCalledWith('echo first',true);
        [...root.querySelectorAll('button')].find(button=>button.textContent==='terminal.edit')!.click();root.querySelector('textarea')!.value='echo changed';
        root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(rows[0]!.command).toBe('echo changed'));
        [...root.querySelectorAll('button')].find(button=>button.textContent==='terminal.delete')!.click();await vi.waitFor(()=>expect(rows).toHaveLength(0));
        expect(error).not.toHaveBeenCalled();
    });
    it('retains the command identity when a save outcome is uncertain', async () => {
        const root=document.createElement('div'),error=vi.fn(),newId=vi.fn(()=> 'stable-id');
        const saveCommand=vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(undefined);
        const storage={listHistory:vi.fn(async()=>[]),listCommands:vi.fn(async()=>[]),saveCommand,deleteCommand:vi.fn()};
        const panel=new CommandPanel(root,storage,key=>key,newId,vi.fn(),error);await panel.show('commands');
        root.querySelector('input')!.value='Name';root.querySelector('textarea')!.value='echo test';
        const submit=()=>root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        submit();await vi.waitFor(()=>expect(error).toHaveBeenCalledOnce());submit();await vi.waitFor(()=>expect(saveCommand).toHaveBeenCalledTimes(2));
        expect(saveCommand.mock.calls.map(call=>call[0].id)).toEqual(['stable-id','stable-id']);expect(newId).toHaveBeenCalledOnce();
    });
});
