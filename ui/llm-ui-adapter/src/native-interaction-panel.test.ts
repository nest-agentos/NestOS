// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {NativeInteractionPanel,type NativeInteractionControls} from './native-interaction-panel';
const panels:NativeInteractionPanel[]=[];
afterEach(()=>{for(const panel of panels.splice(0))panel.destroy();document.body.replaceChildren();vi.restoreAllMocks();});
async function fixture(){
 let state:any={requests:[{id:0,kind:'approval',detail:'reason',approval:{kind:'command',reason:'Review test operation',command:'echo verified',cwd:'/workspace'},decisions:['accept','cancel']}],canRespond:true,disconnected:false};
 const listeners=new Set<()=>void>(),root=document.createElement('div');document.body.append(root);
 const controls={read:vi.fn(async()=>state),refresh:vi.fn(async()=>state),snapshot:()=>state,respond:vi.fn(async()=>{state={...state,requests:[]};return state;}),subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
 const panel=new NativeInteractionPanel(root,controls as NativeInteractionControls);panels.push(panel);await panel.start();
 return {root,panel,controls,get state(){return state;},set state(value){state=value;},emit(){for(const listener of listeners)listener();},listeners};
}
it('uses the native request and response path to approve once and updates after acceptance',async()=>{
 const f=await fixture();expect(f.root.textContent).toContain('Review test operation');
 f.root.querySelector<HTMLButtonElement>('.llm-chat__interaction button')!.click();
 await vi.waitFor(()=>expect(f.controls.respond).toHaveBeenCalledExactlyOnceWith(0,{decision:'accept'}));
 await vi.waitFor(()=>expect(f.root.querySelector('.llm-chat__interaction')).toBeNull());
 expect(f.root.querySelector('[data-interactions-empty]')).not.toBeNull();
});
it('removes a request handled in the chat editor through the shared observation',async()=>{
 const f=await fixture();f.state={...f.state,requests:[]};f.emit();
 expect(f.root.querySelector('.llm-chat__interaction')).toBeNull();expect(f.controls.respond).not.toHaveBeenCalled();
});
it('rejects stale request contents before any response is submitted',async()=>{
 const f=await fixture();f.controls.refresh.mockImplementation(async()=>({...f.state,requests:[]}));
 f.root.querySelector<HTMLButtonElement>('.llm-chat__interaction button')!.click();
 await vi.waitFor(()=>expect(f.root.querySelector('[role=alert]')?.textContent).toContain('STALE_REQUEST'));
 expect(f.controls.respond).not.toHaveBeenCalled();
});
it('keeps unknown response receipts disabled and never replays a response',async()=>{
 const f=await fixture();f.controls.respond.mockImplementation(async()=>{f.state={...f.state,requests:f.state.requests.map((row:any)=>({...row,responding:true}))};return f.state;});
 f.root.querySelector<HTMLButtonElement>('.llm-chat__interaction button')!.click();
 await vi.waitFor(()=>expect(f.root.querySelector('[role=alert]')?.textContent).toContain('INTERACTION_RECEIPT_PENDING'));
 for(const button of f.root.querySelectorAll<HTMLButtonElement>('.llm-chat__interaction button'))expect(button.disabled).toBe(true);
 expect(f.controls.respond).toHaveBeenCalledOnce();
});
it('does not respond after the panel closes while refreshing',async()=>{
 const f=await fixture();let release!:(value:any)=>void;f.controls.refresh.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 f.root.querySelector<HTMLButtonElement>('.llm-chat__interaction button')!.click();f.panel.destroy();release(f.state);
 await new Promise(resolve=>setTimeout(resolve,0));expect(f.controls.respond).not.toHaveBeenCalled();expect(f.listeners.size).toBe(0);
});
it('explains unavailable controls and clears that explanation after the connection recovers',async()=>{
 const f=await fixture();f.state={...f.state,canRespond:false,disconnected:true};f.emit();
 expect(f.root.querySelector('[role=alert]')?.textContent).not.toBe('');
 expect(f.root.querySelector<HTMLButtonElement>('.llm-chat__interaction button')?.disabled).toBe(true);
 f.state={...f.state,canRespond:true,disconnected:false};f.emit();
 expect(f.root.querySelector('[role=alert]')?.textContent).toBe('');
 expect(f.root.querySelector<HTMLButtonElement>('.llm-chat__interaction button')?.disabled).toBe(false);
});
