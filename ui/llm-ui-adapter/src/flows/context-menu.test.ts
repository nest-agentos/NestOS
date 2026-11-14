import {expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({created:vi.fn(),run:vi.fn(async()=>{})}));
vi.mock('./run-flow',()=>({FlowLauncher:class {constructor(options:unknown){calls.created(options);}run=calls.run;}}));
import {createFlowContextMenuConfig} from './context-menu';

it('does not load a launcher while rendering menus and shares it after explicit execution',async()=>{
    const menu=createFlowContextMenuConfig({commands:{} as never,navigate:vi.fn()});
    const defaults:never[]=[];
    expect(menu.items!({id:'/',type:'directory'},defaults)).toBe(defaults);
    const entries=menu.items!({id:'/flows/example.flow',type:'file'},defaults) as Array<{onClick?:()=>Promise<void>}>;
    expect(calls.created).not.toHaveBeenCalled();expect(calls.run).not.toHaveBeenCalled();
    await entries[0].onClick!();await entries[0].onClick!();
    expect(calls.created).toHaveBeenCalledOnce();expect(calls.run).toHaveBeenNthCalledWith(1,'example');expect(calls.run).toHaveBeenCalledTimes(2);
});
