import {authorizationNotice,authorizationError} from './cells-authorization';
import {BaseSettingsEditor, editorResourceId} from '@nestos/ui-common-adapter';
import type {EditorOptions} from '@nestos/ui-common-adapter';
import type {CellsAuthorizationRefresh,CellsNodeOverview,ProjectRemoteMountPort} from '@nestos/app-contracts/services';
import {createModuleLogger, escapeHTML, randomUUID, t} from '@nestos/common';
import {overview} from './cells-overview';

const log=createModuleLogger('cells-settings');
type Auth='bearer'|'basic'|'anonymous';
type Mount=CellsNodeOverview['mounts'][number];
type ProjectAction='open'|'status'|'remount'|'unmount'|'detach';
interface Navigation {
    saved?(id:string):Promise<void>; removed?():Promise<void>;
    project?(mount:Mount,action:ProjectAction):Promise<void>;
}

/** One selected node; navigation owns the node list and credentials stay in its service. */
export class CellsSettingsEditor extends BaseSettingsEditor<ProjectRemoteMountPort|undefined> {
    protected override supportsFormRecovery=true;
    private selected?:string;
    private originalAuth:Auth='bearer';
    private dirty=false;
    private originalFingerprint='';
    private testedFingerprint?:string;
    private busy=false;
    private closed=false;
    private refresh?:AbortController;
    private mounts:Mount[]=[];
    private authorization?:CellsAuthorizationRefresh;
    constructor(container:HTMLElement,service:ProjectRemoteMountPort|undefined,options:EditorOptions,private readonly navigation:Navigation={}) {
        super(container,service,options);
        const path=editorResourceId(options);
        if(path?.startsWith('/')&&path!=='/manage')this.selected=decodeURIComponent(path.slice(1));
    }
    async render():Promise<void> {
        this.clearListeners();
        const node=this.selected?this.service?.connections().find(n=>n.id===this.selected):undefined;
        this.originalAuth=node?.anonymous?'anonymous':node?.username?'basic':'bearer';
        this.container.innerHTML=`<div class="settings-page cells-node">
            <header class="cells-node__header"><div><h2 data-cells-title>${escapeHTML(node?.name??t('cells.new'))}</h2>
            <p class="cells-node__endpoint">${escapeHTML(node?.endpoint??t('cells.description'))}</p></div>
            ${this.selected?'<span class="cells-node__status" data-cells-state></span>':''}</header>
            ${this.selected?this.toolbar()+'<section data-cells-authorization aria-live="polite"></section><section data-cells-overview aria-live="polite"></section>':''}
            <details class="cells-node__configuration" ${this.selected?'':'open'}><summary>${escapeHTML(t('cells.connection'))}</summary>${this.formTemplate()}</details>
            <p class="cells-node__feedback" data-cells-status role="status" aria-live="polite"></p></div>`;
        this.fill(node);this.originalFingerprint=this.fingerprint();this.bind();this.updateStatus();this.saveButton();
        if(!this.service||this.selected&&!node){this.message(t(this.service?'cells.missing':'cells.unavailable'),true);this.disable(true);return;}
        if(this.selected)await this.refreshOverview();
    }
    private toolbar():string {
        return `<div class="cells-node__toolbar">${['check','refresh','remove'].map(action=>`<button type="button" class="settings-btn settings-btn--secondary" data-cells-action="${action}">${escapeHTML(t(`cells.${action}` as Parameters<typeof t>[0]))}</button>`).join('')}</div>`;
    }
    private field(key:'name'|'endpoint'|'username'|'password',type='text'):string {
        return `<label class="cells-node__field" data-cells-field="${key}"><span>${escapeHTML(t(`cells.${key}`))}</span><input name="${key}" type="${type}" autocomplete="${key==='password'?'new-password':'off'}" ${key==='name'||key==='endpoint'?'required':''}></label>`;
    }
    private formTemplate():string {
        return `<form class="cells-node__form" data-cells-form>${this.field('name')}${this.field('endpoint')}
            <label class="cells-node__field">${escapeHTML(t('cells.auth'))}<select name="auth">${(['bearer','basic','anonymous'] as const).map(auth=>`<option value="${auth}">${escapeHTML(t(`cells.auth.${auth}`))}</option>`).join('')}</select></label>
            ${this.field('username')}${this.field('password','password')}<p class="cells-node__hint">${escapeHTML(t('cells.credentialHint'))}</p>
            <div class="cells-node__actions"><button type="button" class="settings-btn settings-btn--secondary" data-cells-action="test">${escapeHTML(t('cells.test'))}</button><button type="submit" class="settings-btn" data-cells-save>${escapeHTML(t('cells.save'))}</button><button type="button" class="settings-btn settings-btn--secondary" data-cells-action="cancel">${escapeHTML(t('cells.cancel'))}</button></div></form>`;
    }
    private form():HTMLFormElement{return this.container.querySelector('[data-cells-form]')!;}
    private control(key:string):HTMLInputElement|HTMLSelectElement{return this.form().elements.namedItem(key) as HTMLInputElement;}
    private fill(node:ReturnType<ProjectRemoteMountPort['connections']>[number]|undefined):void {
        for(const key of ['name','endpoint','username'] as const)this.control(key).value=node?.[key]??'';
        this.control('auth').value=this.originalAuth;this.authFields();
    }
    private authFields():void {
        const auth=this.control('auth').value;
        this.container.querySelector<HTMLElement>('[data-cells-field="username"]')!.hidden=auth!=='basic';
        this.container.querySelector<HTMLElement>('[data-cells-field="password"]')!.hidden=auth==='anonymous';
        this.control('username').required=auth==='basic';
        this.control('password').required=auth!=='anonymous'&&(!this.selected||auth!==this.originalAuth);
        this.container.querySelector('[data-cells-field="password"] span')!.textContent=t(auth==='bearer'?'cells.token':'cells.password');
    }
    private bind():void {
        this.addEventListener(this.form(),'submit',event=>{event.preventDefault();void this.run('save',()=>this.save(true));});
        this.addEventListener(this.form(),'input',()=>{this.dirty=true;this.saveButton();});
        this.addEventListener(this.control('auth'),'change',()=>{this.dirty=true;this.authFields();this.saveButton();});
        this.addEventListener(this.container,'click',event=>{
            const mountAction=(event.target as HTMLElement).closest<HTMLElement>('[data-cells-project-action]');
            if(mountAction){void this.run('project',()=>this.openProject(mountAction));return;}
            const action=(event.target as HTMLElement).closest<HTMLElement>('[data-cells-action]')?.dataset.cellsAction;
            if(action==='cancel')this.cancel();
            if(action==='test'&&this.form().reportValidity())void this.run('test',()=>this.testDraft());
            if(action==='authorization')void this.run('authorization',()=>this.confirmAuthorization());
            if(action==='configure'){this.container.querySelector<HTMLDetailsElement>('.cells-node__configuration')!.open=true;this.control('endpoint').focus();}
            if(action==='refresh')void this.refreshOverview();
            if(action==='check')void this.run('check',async()=>{await this.service!.checkConnection(this.selected!);await this.refreshOverview();});
            if(action==='remove'&&confirm(t('cells.removeConfirm')))void this.run('remove',async()=>{
                await this.service!.removeConnection(this.selected!);this.dirty=false;await this.navigation.removed?.();});
        });
    }
    protected override onServiceChange():void {this.updateStatus();}
    private updateStatus():void {
        const state=this.selected?this.service?.connectionStatus(this.selected)??'unknown':'unknown';
        const node=this.selected?this.service?.connections().find(n=>n.id===this.selected):undefined;
        if(node&&!this.dirty){this.container.querySelector('[data-cells-title]')!.textContent=node.name;this.container.querySelector('.cells-node__endpoint')!.textContent=node.endpoint;}
        const badge=this.container.querySelector<HTMLElement>('[data-cells-state]');
        if(badge){badge.dataset.state=state;badge.textContent=t(`cells.status.${state}`);}
        if(this.selected&&!this.service?.connections().some(n=>n.id===this.selected)){this.disable(true);this.message(t('cells.missing'),true);}
    }
    private async refreshOverview():Promise<void> {
        if(!this.selected||!this.service||this.closed)return;
        this.refresh?.abort();const controller=this.refresh=new AbortController();
        const target=this.container.querySelector<HTMLElement>('[data-cells-overview]')!;
        if(!target)return;
        this.mounts=[];target.textContent=t('cells.loading');
        try {
            const value=await this.service.nodeOverview(this.selected,{signal:controller.signal,timeoutMs:3000});
            if(!controller.signal.aborted&&!this.closed){this.mounts=value.mounts;target.innerHTML=overview(value,!!this.navigation.project);this.authorization=value.authorizationRefresh;this.renderAuthorization();}
        }catch(error){if(!controller.signal.aborted&&!this.closed)target.textContent=error instanceof Error?error.message:t('cells.failed');}
    }
    private renderAuthorization():void {
        const target=this.container.querySelector<HTMLElement>('[data-cells-authorization]');
        if(target)target.innerHTML=authorizationNotice(this.authorization);
    }
    private async confirmAuthorization():Promise<void> {
        if(this.authorization?.state!=='available'||!this.selected)return;
        if(Date.now()>=this.authorization.expiresAt){await this.refreshOverview();throw new Error('CELLS_AUTHORIZATION_REFRESH_EXPIRED');}
        try{await this.service!.confirmAuthorizationRefresh(this.selected,this.authorization.proposalId,{timeoutMs:5000});}
        catch(error){await this.refreshOverview();throw error;}
        this.authorization=undefined;this.renderAuthorization();
        await this.refreshOverview();
    }
    private async openProject(element:HTMLElement):Promise<void> {
        const {cellsProject:projectId,cellsMount:mountId,cellsProjectAction:action}=element.dataset;
        const mount=this.mounts.find(item=>item.projectId===projectId&&item.mountId===mountId);
        if(!mount||!['open','status','remount','unmount','detach'].includes(action??''))return;
        if(action==='remount'&&!mount.canRemount||action==='unmount'&&mount.unmount!=='project'||action==='detach'&&mount.unmount!=='directory')return;
        await this.navigation.project?.(mount,action as ProjectAction);
        if(action!=='open'&&!this.closed)await this.refreshOverview();
    }
    private fingerprint():string {return JSON.stringify(['endpoint','auth','username','password'].map(key=>this.control(key).value));}
    private canSave():boolean {return this.testedFingerprint===this.fingerprint()||!!this.selected&&this.fingerprint()===this.originalFingerprint;}
    private saveButton():void {const button=this.container.querySelector<HTMLButtonElement>('[data-cells-save]');if(button)button.disabled=this.busy||!this.service||!this.canSave();}
    private async testDraft():Promise<void> {
        const fingerprint=this.fingerprint(),draft=this.draft();
        await this.service!.checkDraft(draft.input,draft.password,this.selected,{timeoutMs:5000});
        if(this.fingerprint()===fingerprint)this.testedFingerprint=fingerprint;
    }
    private draft(){
        const value=(key:string)=>this.control(key).value,auth=value('auth') as Auth,password=auth==='anonymous'?'':value('password');
        if(auth!=='anonymous'&&(!this.selected||auth!==this.originalAuth)&&!password)throw new Error(t('cells.credentialRequired'));
        return {input:{name:value('name'),endpoint:value('endpoint'),...(auth==='basic'?{username:value('username')}:{}),...(auth==='anonymous'?{anonymous:true}:{})},password,auth};
    }
    private async save(navigate=false):Promise<void> {
        if(!this.service)throw new Error(t('cells.unavailable'));
        if(!this.canSave())throw new Error(t('cells.testRequired'));
        const {input,password,auth}=this.draft();
        const created=!this.selected;
        const id=await this.service.saveConnection(input,password,this.selected,{requireTested:true});
        this.selected=id;this.originalAuth=auth;this.dirty=false;this.control('password').value='';this.authFields();this.originalFingerprint=this.fingerprint();this.testedFingerprint=undefined;
        if(navigate&&this.navigation.saved){if(created){this.selected=undefined;this.form().reset();this.originalAuth='bearer';this.authFields();}await this.navigation.saved(id);}
        else if(!this.closed)await this.refreshOverview();
    }
    private async run(action:'save'|'test'|'check'|'remove'|'project'|'authorization',work:()=>Promise<void>):Promise<void> {
        if(this.busy)return;this.busy=true;this.disable(true);
        const operationId=randomUUID(),started=performance.now();
        try{await work();if(!this.closed&&action!=='project')this.message(t(action==='authorization'?'cells.authorization.updated':action==='test'?'cells.tested':action==='check'?'cells.checked':'cells.saved'));log.info('cells.action.completed',{operationId,operation:action,stage:'complete',result:'success',durationMs:Math.round(performance.now()-started)});}
        catch(error){if(!this.closed)this.message(authorizationError(error)??(error instanceof Error?(error.message.includes('CELLS_TEST_REQUIRED')?t('cells.testRequired'):error.message):t('cells.failed')),true);log.warn('cells.action.failed',{operationId,operation:action,stage:'complete',result:'failure',code:(error as {code?:string})?.code??'CELLS_ACTION_FAILED',durationMs:Math.round(performance.now()-started)});}
        finally{this.busy=false;if(!this.closed){this.disable(false);this.authFields();this.updateStatus();this.saveButton();}}
    }
    private disable(disabled:boolean):void{this.container.querySelectorAll<HTMLInputElement>('button,input,select').forEach(control=>control.disabled=disabled);}
    private message(text:string,error=false):void{const target=this.container.querySelector<HTMLElement>('[data-cells-status]');if(target){target.textContent=text;target.dataset.error=String(error);}}
    private cancel():void {
        const node=this.selected?this.service?.connections().find(n=>n.id===this.selected):undefined;
        this.originalAuth=node?.anonymous?'anonymous':node?.username?'basic':'bearer';this.fill(node);
        this.control('password').value='';this.dirty=false;this.testedFingerprint=undefined;this.originalFingerprint=this.fingerprint();this.message('');this.saveButton();
    }
    protected override captureRecoveryModel():unknown{return {dirty:this.dirty};}
    protected override restoreRecoveryModel(value:unknown):void{this.dirty=(value as {dirty?:boolean})?.dirty===true;}
    protected override afterRestoreRecovery():void{this.authFields();this.testedFingerprint=undefined;this.saveButton();}
    override captureRecovery():unknown{if(this.busy)throw Object.assign(new Error(t('httpApp.recoveryBusy')),{code:'RECOVERY_BUSY'});return super.captureRecovery();}
    override isDirty():boolean{return this.dirty;}
    override setDirty(value:boolean):void{this.dirty=value;}
    override async flushPendingSave():Promise<void>{if(this.dirty)throw new Error(t('cells.unsaved'));}
    override async destroy():Promise<void>{this.closed=true;this.refresh?.abort();await super.destroy();}
}
