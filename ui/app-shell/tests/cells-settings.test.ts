// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {CellsSettingsEditor} from '@nestos/app-settings';
import type {CellsNodeOverview,ProjectRemoteMountPort} from '@nestos/app-contracts/services';
import type {EditorOptions} from '@nestos/ui-common-adapter';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();document.body.replaceChildren();vi.restoreAllMocks();});
function snapshot():CellsNodeOverview{return {connectionId:'node-a',sampledAt:Date.now(),mounts:[{projectId:'demo',projectName:'Demo',mountId:'root',alias:'prj',root:'/x1',at:'/',access:'rw',status:'unknown',projectStatus:'offline',canRemount:true,unmount:'project'}],statistics:{state:'unsupported'}};}
async function setup(pending?:Promise<CellsNodeOverview>){
    const project=vi.fn(async()=>{}),confirmAuthorizationRefresh=vi.fn(async()=>{});
    let change=()=>{};
    const connection={id:'node-a',name:'VM cells',endpoint:'http://127.0.0.1:18787',credentialRef:'private-ref'};
    const nodeOverview=vi.fn(async()=>pending??snapshot()),saveConnection=vi.fn(async()=>connection.id),checkDraft=vi.fn(async()=>{});
    const service={connections:()=>[connection],connectionStatus:()=> 'online',nodeOverview,saveConnection,confirmAuthorizationRefresh,
        checkDraft,checkConnection:vi.fn(async()=>{}),onChange:(listener:()=>void)=>{change=listener;return ()=>{};}} as unknown as ProjectRemoteMountPort;
    const root=document.createElement('div');document.body.append(root);
    const editor=new CellsSettingsEditor(root,service,{target:{kind:'file',path:'/node-a'}} as EditorOptions,{project});
    const initialized=editor.init(root);cleanups.push(()=>editor.destroy());
    return {root,editor,initialized,nodeOverview,saveConnection,checkDraft,project,confirmAuthorizationRefresh,change:()=>change()};
}
it('shows only the selected node, its project paths and an honest unsupported statistics state',async()=>{
    const f=await setup();await f.initialized;
    expect(f.root.querySelector('[data-cells-list]')).toBeNull();
    expect(f.root.textContent).toContain('Demo');expect(f.root.textContent).toContain('/prj/x1');
    expect(f.root.textContent).toContain('此节点尚未提供资源统计接口');
    expect(f.root.querySelector<HTMLInputElement>('[name=password]')!.value).toBe('');
    expect(f.nodeOverview).toHaveBeenCalledTimes(1);
    expect(f.root.querySelector('[data-cells-field=username]')!.hasAttribute('hidden')).toBe(true);
});
it('keeps unsaved inputs and credentials across service notifications and explicit overview refresh',async()=>{
    const f=await setup();await f.initialized;
    const input=f.root.querySelector<HTMLInputElement>('[name=name]')!;input.value='Unsaved name';input.dispatchEvent(new Event('input',{bubbles:true}));
    const secret=f.root.querySelector<HTMLInputElement>('[name=password]')!;secret.value='memory-only-secret';
    f.change();expect(input.value).toBe('Unsaved name');expect(secret.value).toBe('memory-only-secret');expect(f.editor.isDirty()).toBe(true);
    f.root.querySelector<HTMLButtonElement>('[data-cells-action=refresh]')!.click();
    await vi.waitFor(()=>expect(f.nodeOverview).toHaveBeenCalledTimes(2));
    expect(secret.value).toBe('memory-only-secret');expect(f.saveConnection).not.toHaveBeenCalled();
});
it('does not reuse a bearer token when changing authentication mode',async()=>{
    const f=await setup();await f.initialized;
    const auth=f.root.querySelector<HTMLSelectElement>('[name=auth]')!;auth.value='basic';auth.dispatchEvent(new Event('change',{bubbles:true}));
    f.root.querySelector<HTMLInputElement>('[name=username]')!.value='alice';
    f.root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(f.root.querySelector('[data-cells-status]')!.textContent).toContain('请先测试'));
    expect(f.saveConnection).not.toHaveBeenCalled();
});
it('ignores a late overview response after destruction',async()=>{
    let resolve!:(v:CellsNodeOverview)=>void;const pending=new Promise<CellsNodeOverview>(r=>resolve=r);
    const f=await setup(pending);await f.editor.destroy();resolve(snapshot());await f.initialized;
    expect(f.root.textContent).toBe('');
});

it('tests an edited draft without saving, then saves without a second connection test',async()=>{
    const f=await setup();await f.initialized;
    const endpoint=f.root.querySelector<HTMLInputElement>('[name=endpoint]')!;endpoint.value='http://127.0.0.1:28787';endpoint.dispatchEvent(new Event('input',{bubbles:true}));
    const save=f.root.querySelector<HTMLButtonElement>('[data-cells-save]')!;expect(save.disabled).toBe(true);
    f.root.querySelector<HTMLButtonElement>('[data-cells-action=test]')!.click();
    await vi.waitFor(()=>expect(f.root.querySelector('[data-cells-status]')!.textContent).toContain('尚未保存'));
    expect(f.checkDraft).toHaveBeenCalledTimes(1);expect(f.saveConnection).not.toHaveBeenCalled();expect(save.disabled).toBe(false);
    save.click();await vi.waitFor(()=>expect(f.saveConnection).toHaveBeenCalledTimes(1));
    expect(f.saveConnection.mock.calls[0][3]).toEqual({requireTested:true});expect(f.checkDraft).toHaveBeenCalledTimes(1);
    endpoint.value='http://127.0.0.1:38787';endpoint.dispatchEvent(new Event('input',{bubbles:true}));expect(save.disabled).toBe(true);
});

it('keeps separate subdirectory rows and delegates only the selected mount operation',async()=>{
    const value=snapshot(),root=value.mounts[0]!;
    value.mounts.push({...root,mountId:'docs',root:'/x1/docs',at:'/docs',status:'online',canRemount:false,unmount:'directory'},
        {...root,mountId:'tests',root:'/x1/tests',at:'/tests',status:'offline',canRemount:false,unmount:'directory'});
    const f=await setup(Promise.resolve(value));await f.initialized;
    expect(f.root.querySelectorAll('tbody tr')).toHaveLength(3);
    const docs=f.root.querySelector<HTMLButtonElement>('[data-cells-mount="docs"][data-cells-project-action="detach"]')!;
    expect(docs).not.toBeNull();expect(f.root.textContent).toContain('/prj/x1/docs');
    expect(f.root.querySelector('[data-cells-mount="docs"][data-cells-project-action="remount"]')).toBeNull();
    docs.click();await vi.waitFor(()=>expect(f.project).toHaveBeenCalledWith(value.mounts[1],'detach'));
    expect(f.project).toHaveBeenCalledTimes(1);expect(f.saveConnection).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(f.root.querySelector<HTMLButtonElement>('[data-cells-mount="tests"][data-cells-project-action="status"]')!.disabled).toBe(false));
    f.root.querySelector<HTMLButtonElement>('[data-cells-mount="tests"][data-cells-project-action="status"]')!.click();
    await vi.waitFor(()=>expect(f.project).toHaveBeenLastCalledWith(value.mounts[2],'status'));
});

function authorizationSnapshot():CellsNodeOverview {
    return {...snapshot(),authorizationRefresh:{state:'available',proposalId:'proposal',serverId:'node',principalId:'owner',previousRevision:'a'.repeat(64),nextRevision:'b'.repeat(64),detectedAt:Date.now(),expiresAt:Date.now()+60_000,affectedProjectIds:['demo']}};
}
it('explains an authorization change and waits for explicit confirmation without overwriting a dirty draft',async()=>{
    const f=await setup(Promise.resolve(authorizationSnapshot()));await f.initialized;
    expect(f.confirmAuthorizationRefresh).not.toHaveBeenCalled();expect(f.root.textContent).toContain('尚未更新');
    expect(f.root.textContent).toContain('服务器身份');expect(f.root.textContent).toContain('项目状态');
    const name=f.root.querySelector<HTMLInputElement>('[name=name]')!;name.value='Unsaved';name.dispatchEvent(new Event('input',{bubbles:true}));
    f.nodeOverview.mockResolvedValue(snapshot());f.root.querySelector<HTMLButtonElement>('[data-cells-action=authorization]')!.click();
    await vi.waitFor(()=>expect(f.confirmAuthorizationRefresh).toHaveBeenCalledWith('node-a','proposal',{timeoutMs:5000}));
    await vi.waitFor(()=>expect(f.root.querySelector('[data-cells-status]')!.textContent).toContain('指纹已更新'));
    expect(name.value).toBe('Unsaved');expect(f.editor.isDirty()).toBe(true);expect(f.saveConnection).not.toHaveBeenCalled();
    expect(f.root.querySelector('[data-cells-action=authorization]')).toBeNull();
});
it.each([
    [{state:'blocked',reason:'server-changed'},'核对节点地址'],
    [{state:'blocked',reason:'principal-changed'},'核对用户名和凭据'],
    [{state:'unavailable',code:'ETIMEDOUT'},'重新检查授权']
] as const)('shows actionable instructions when authorization cannot be updated: %s',async(value,text)=>{
    const f=await setup(Promise.resolve({...snapshot(),authorizationRefresh:value}));await f.initialized;
    expect(f.root.textContent).toContain(text);expect(f.root.querySelector('[data-cells-action=authorization]')).toBeNull();
    expect(f.confirmAuthorizationRefresh).not.toHaveBeenCalled();
    f.root.querySelector<HTMLButtonElement>('[data-cells-action=configure]')!.click();
    expect(f.root.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
    expect(document.activeElement).toBe(f.root.querySelector('[name=endpoint]'));
});
it('explains an expired authorization proposal without submitting it',async()=>{
    const value=authorizationSnapshot();if(value.authorizationRefresh?.state==='available')value.authorizationRefresh.expiresAt=Date.now()-1;
    const f=await setup(Promise.resolve(value));await f.initialized;
    f.root.querySelector<HTMLButtonElement>('[data-cells-action=authorization]')!.click();
    await vi.waitFor(()=>expect(f.root.querySelector('[data-cells-status]')!.textContent).toContain('已过期'));
    expect(f.confirmAuthorizationRefresh).not.toHaveBeenCalled();expect(f.saveConnection).not.toHaveBeenCalled();
});
