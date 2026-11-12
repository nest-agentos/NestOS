// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {renderConversationRequests,clearConversationRequests} from './remote-interactions';
import type {ConversationRequest} from '../contracts';
it('preserves expanded command details during observation and sends only the selected native decision',async()=>{
 const container=document.createElement('div'),respond=vi.fn(async()=>{});
 const request:ConversationRequest={id:17,kind:'approval',detail:'',approval:{kind:'command',reason:'Update the requested script',command:'python3 verify.py'},decisions:['accept','decline']};
 renderConversationRequests(container,[request],respond,true);
 const disclosure=container.querySelector('details')!;expect(disclosure.open).toBe(false);
 disclosure.open=true;disclosure.dispatchEvent(new Event('toggle'));
 renderConversationRequests(container,[{...request,responding:true}],respond,true);
 expect(container.querySelector('details')).toBe(disclosure);expect(disclosure.open).toBe(true);expect(container.querySelector('button')!.disabled).toBe(true);
 renderConversationRequests(container,[request],respond,true);container.querySelector('button')!.click();
 await vi.waitFor(()=>expect(respond).toHaveBeenCalledWith(17,{decision:'accept'}));clearConversationRequests(container);
 expect(container.childElementCount).toBe(0);
});
