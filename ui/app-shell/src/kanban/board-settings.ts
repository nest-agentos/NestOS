import {createModuleLogger, randomUUID, t} from '@nestos/common';
import {boardSettingsFields} from '@nestos/kanban-ui';
import type {KanbanBoardSummary, KanbanBoardSettingsCatalog, KanbanClient} from '@nestos/kanban/contracts';
const log=createModuleLogger('kanban-settings');
interface Draft {board:KanbanBoardSummary;catalog:KanbanBoardSettingsCatalog;form:HTMLFormElement;operationId?:string;fingerprint?:string;unknown?:boolean}
const label=(key:string)=>t(('kanban.'+key) as Parameters<typeof t>[0]);
/** Both workspace settings entrances use this catalog and revision-checked editor. */
export class KanbanBoardSettings {
    readonly element=document.createElement('section');
    private readonly drafts=new Map<string,Draft>();
    private generation=0;
    private closed=false;
    constructor(private readonly service:KanbanClient,private readonly changed:()=>Promise<void>,private readonly saved:()=>void,
        private readonly busy:(value:boolean)=>void) {}
    async select(boardId?:string):Promise<void> {
        const generation=++this.generation;this.element.replaceChildren();if(!this.service.boardSettings||this.closed)return;
        const title=document.createElement('h3');title.textContent=label('boardControl.harness');this.element.append(title);
        if(!boardId){const help=document.createElement('p');help.textContent=label('boardControl.selectBoard');this.element.append(help);return;}
        const cached=this.drafts.get(boardId);if(cached){this.element.append(cached.form);return;}
        const status=document.createElement('p');status.setAttribute('role','status');status.textContent=label('boardControl.loading');this.element.append(status);
        const operationId=randomUUID(),started=performance.now();
        try {
            const [board,catalog]=await Promise.all([this.service.read(boardId),this.service.boardSettings(boardId)]);
            if(this.closed||generation!==this.generation)return;
            const draft=this.create(board,catalog);this.drafts.set(boardId,draft);status.remove();this.element.append(draft.form);
            log.debug('settings.read',{operationId,boardId,stage:'catalog.read',result:'success',count:catalog.fields.length,durationMs:Math.round(performance.now()-started)});
        } catch(error){if(!this.closed&&generation===this.generation){this.failure(status,error,operationId,boardId,'catalog.read',started);const retry=document.createElement('button');retry.type='button';retry.textContent=label('refresh');retry.onclick=()=>{void this.select(boardId);};this.element.append(retry);}}
    }
    observeControl(board:KanbanBoardSummary,previousRevision:number):void {
        const draft=this.drafts.get(board.id);
        if(draft&&!draft.unknown&&draft.board.revision===previousRevision)draft.board={...draft.board,revision:board.revision};
    }
    destroy():void {this.closed=true;this.generation++;this.drafts.clear();this.element.remove();}
    private create(board:KanbanBoardSummary,catalog:KanbanBoardSettingsCatalog):Draft {
        const form=document.createElement('form');form.dataset.boardSettings=board.id;form.innerHTML=boardSettingsFields(board,catalog);
        const status=document.createElement('p');status.setAttribute('role','status');form.append(status);
        const save=document.createElement('button');save.type='submit';save.textContent=label('save');
        const refresh=document.createElement('button');refresh.type='button';refresh.textContent=label('refresh');
        refresh.onclick=()=>{this.drafts.delete(board.id);void this.select(board.id);};const actions=document.createElement('div');actions.className='kanban-sidebar-controls__actions';actions.append(save,refresh);form.append(actions);
        const draft={board,catalog,form};form.onsubmit=event=>{event.preventDefault();void this.submit(draft,status);};return draft;
    }
    private async submit(draft:Draft,status:HTMLElement):Promise<void> {
        if(this.closed||draft.form.getAttribute('aria-busy')==='true')return;
        const settings={...draft.board.settings},data=new FormData(draft.form);
        for(const field of draft.catalog.fields)settings[field.name]=String(data.get('setting-'+field.name)??draft.board.settings?.[field.name]??'');
        const command=draft.unknown&&draft.fingerprint?JSON.parse(draft.fingerprint) as {type:'configure-board-settings';settings:Record<string,string>}:{type:'configure-board-settings' as const,settings},fingerprint=JSON.stringify(command);
        if(draft.fingerprint!==fingerprint){draft.operationId=randomUUID();draft.fingerprint=fingerprint;}
        const operationId=draft.operationId!,started=performance.now();this.busy(true);draft.form.setAttribute('aria-busy','true');
        status.setAttribute('role','status');status.textContent=label('boardControl.processing');
        this.disable(draft,true);
        try {
            await this.service.execute(draft.board.id,{operationId,expectedRevision:draft.board.revision,command});
            log.debug('settings.save',{operationId,boardId:draft.board.id,stage:'commit',result:'success',durationMs:Math.round(performance.now()-started)});
            this.drafts.delete(draft.board.id);this.saved();await this.changed();
        } catch(error){draft.unknown=(error as {outcome?:string})?.outcome==='unknown';if(!this.closed)this.failure(status,error,operationId,draft.board.id,'commit',started);}
        finally{draft.form.removeAttribute('aria-busy');this.disable(draft,false);this.busy(false);}
    }
    private disable(draft:Draft,saving:boolean):void {
        draft.form.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('button,select').forEach(input=>{input.disabled=saving||!!draft.unknown&&(input.tagName==='SELECT'||input instanceof HTMLButtonElement&&input.type==='button');});
    }
    private failure(status:HTMLElement,error:unknown,operationId:string,boardId:string,stage:string,started:number):void {
        const raw=(error as {code?:unknown})?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'KANBAN_OPERATION_FAILED';
        const translated=label('errors.'+code);status.setAttribute('role','alert');status.textContent=(translated==='kanban.errors.'+code?label('failed'):translated)+' · '+code;
        log.warn('settings.failed',{operationId,boardId,stage,result:'failure',code,durationMs:Math.round(performance.now()-started)});
    }
}
