import {createModuleLogger, randomUUID, t} from '@nestos/common';
import {boardSettingsCommand,boardSettingsFields} from '@nestos/kanban-ui';
import type {KanbanBoardSummary, KanbanBoardSettingsCatalog, KanbanClient} from '@nestos/kanban/contracts';
import type {ApplicationBackend} from '@nestos/app-contracts/services';
const log=createModuleLogger('kanban-settings');
type BoardSettingsState=Pick<KanbanBoardSummary,'id'|'revision'|'settings'>;
export type GlobalHarnessDefaults=Required<Pick<ApplicationBackend,'readKanbanHarnessDefaults'|'saveKanbanHarnessDefaults'>>;
export const allBoards='*';
interface Draft {board:BoardSettingsState;catalog:KanbanBoardSettingsCatalog;form:HTMLFormElement;operationId?:string;fingerprint?:string;unknown?:boolean}
const harnessLabels={
    'harness-decision':'modelDefaults.harnessDecision',
    'harness-coordination':'modelDefaults.harnessCoordination',
    'harness-execution':'modelDefaults.harnessExecution',
} as const;
const label=(key:string)=>t(('kanban.'+key) as Parameters<typeof t>[0]);
/** Both workspace settings entrances use this catalog and revision-checked editor. */
export class KanbanBoardSettings {
    readonly element=document.createElement('section');
    private readonly drafts=new Map<string,Draft>();
    private generation=0;
    private closed=false;
    constructor(private readonly service:KanbanClient,private readonly changed:()=>Promise<void>,private readonly saved:()=>void,
        private readonly busy:(value:boolean)=>void, private readonly global?:GlobalHarnessDefaults) {}
    async select(boardId?:string):Promise<void> {
        const generation=++this.generation;this.element.replaceChildren();if(this.closed)return;
        if(!this.global){const title=document.createElement('h3');title.textContent=label('settingsTitle');this.element.append(title);}
        if(!boardId){
            if(!this.global){const help=document.createElement('p');help.textContent=label('boardControl.selectBoard');this.element.append(help);}
            return;
        }
        const cached=this.drafts.get(boardId);if(cached){this.element.append(cached.form);return;}
        const status=document.createElement('p');status.setAttribute('role','status');status.textContent=label('boardControl.loading');this.element.append(status);
        const operationId=randomUUID(),started=performance.now();
        try {
            const [board,catalog]=await this.read(boardId);
            if(this.closed||generation!==this.generation)return;
            const draft=this.create(board,catalog);this.drafts.set(boardId,draft);status.remove();this.element.append(draft.form);
            log.debug('settings.read',{operationId,boardId,stage:'catalog.read',result:'success',count:catalog.fields.length,durationMs:Math.round(performance.now()-started)});
        } catch(error){if(!this.closed&&generation===this.generation){this.failure(status,error,operationId,boardId,'catalog.read',started);const retry=document.createElement('button');retry.type='button';retry.textContent=label('refresh');retry.onclick=()=>{void this.select(boardId);};this.element.append(retry);}}
    }
    private async read(id:string):Promise<[BoardSettingsState,KanbanBoardSettingsCatalog]> {
        if(this.global&&id===allBoards){
            const {catalog,...settings}=await this.global.readKanbanHarnessDefaults();
            return [{id,...settings},harnessCatalog(catalog,false)];
        }
        const [board,catalog]=await Promise.all([this.board(id),this.service.boardSettings?.(id)??{fields:[]}]);
        return [board,this.global?harnessCatalog(catalog,true):catalog];
    }
    private async board(id:string):Promise<KanbanBoardSummary> {
        if(!this.global)return this.service.read(id);
        const board=(await this.service.catalog(id)).find(board=>board.id===id);
        if(!board)throw Object.assign(new Error('Board unavailable'),{code:'ENOENT'});
        return board;
    }
    observeControl(board:KanbanBoardSummary,previousRevision:number):void {
        const draft=this.drafts.get(board.id);
        if(draft&&!draft.unknown&&draft.board.revision===previousRevision)draft.board={...draft.board,revision:board.revision};
    }
    destroy():void {this.closed=true;this.generation++;this.drafts.clear();this.element.remove();}
    private create(board:BoardSettingsState,catalog:KanbanBoardSettingsCatalog):Draft {
        const form=document.createElement('form');form.dataset.boardSettings=board.id;
        if(this.global)form.append(harnessFields(board,catalog));
        else form.innerHTML=boardSettingsFields(board as KanbanBoardSummary,catalog,label);
        const status=document.createElement('p');status.setAttribute('role','status');form.append(status);
        const save=document.createElement('button');save.type='submit';save.textContent=label('save');
        const refresh=document.createElement('button');refresh.type='button';refresh.textContent=label('refresh');
        refresh.onclick=()=>{this.drafts.delete(board.id);void this.select(board.id);};const actions=document.createElement('div');actions.className='kanban-sidebar-controls__actions';actions.append(save,refresh);form.append(actions);
        const draft={board,catalog,form};form.onsubmit=event=>{event.preventDefault();void this.submit(draft,status);};return draft;
    }
    private async submit(draft:Draft,status:HTMLElement):Promise<void> {
        if(this.closed||draft.form.getAttribute('aria-busy')==='true')return;
        const command=draft.unknown&&draft.fingerprint?JSON.parse(draft.fingerprint) as ReturnType<typeof boardSettingsCommand>
            :this.command(draft);
        const fingerprint=JSON.stringify(command);
        if(draft.fingerprint!==fingerprint){draft.operationId=randomUUID();draft.fingerprint=fingerprint;}
        const operationId=draft.operationId!,started=performance.now();this.busy(true);draft.form.setAttribute('aria-busy','true');
        status.setAttribute('role','status');status.textContent=label('boardControl.processing');
        this.disable(draft,true);
        try {
            const result=await this.save(draft.board,operationId,command);
            log.debug('settings.save',{operationId,boardId:draft.board.id,stage:'commit',result:'success',durationMs:Math.round(performance.now()-started)});
            if(this.global){
                draft.board=result;draft.operationId=undefined;draft.fingerprint=undefined;draft.unknown=false;
                status.textContent=t('modelDefaults.harnessSaved');
            }else{this.drafts.delete(draft.board.id);this.saved();await this.changed();}
        } catch(error){draft.unknown=(error as {outcome?:string})?.outcome==='unknown';if(!this.closed)this.failure(status,error,operationId,draft.board.id,'commit',started);}
        finally{draft.form.removeAttribute('aria-busy');this.disable(draft,false);this.busy(false);}
    }
    private async save(board:BoardSettingsState,operationId:string,command:ReturnType<typeof boardSettingsCommand>):Promise<BoardSettingsState> {
        if(this.global&&board.id===allBoards)
            return {id:board.id,...await this.global.saveKanbanHarnessDefaults({operationId,revision:board.revision,settings:command.settings})};
        return this.service.execute(board.id,{operationId,expectedRevision:board.revision,command});
    }
    private command(draft:Draft):ReturnType<typeof boardSettingsCommand> {
        const command=boardSettingsCommand(new FormData(draft.form),draft.catalog,draft.board.settings??{});
        return this.global?{type:command.type,settings:command.settings}:command;
    }
    private disable(draft:Draft,saving:boolean):void {
        draft.form.querySelectorAll<HTMLButtonElement|HTMLSelectElement|HTMLInputElement>('button,select,input').forEach(input=>{input.disabled=saving||!!draft.unknown&&(input.tagName==='SELECT'||input.tagName==='INPUT'||input instanceof HTMLButtonElement&&input.type==='button');});
    }
    private failure(status:HTMLElement,error:unknown,operationId:string,boardId:string,stage:string,started:number):void {
        const raw=(error as {code?:unknown})?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'KANBAN_OPERATION_FAILED';
        const translated=label('errors.'+code);status.setAttribute('role','alert');status.textContent=(translated==='kanban.errors.'+code?label('failed'):translated)+' · '+code;
        log.warn('settings.failed',{operationId,boardId,stage,result:'failure',code,durationMs:Math.round(performance.now()-started)});
    }
}

function harnessCatalog(catalog:KanbanBoardSettingsCatalog,board:boolean):KanbanBoardSettingsCatalog {
    const fields=catalog.fields.filter(field=>Object.hasOwn(harnessLabels,field.name)).map(field=>({
        ...field,label:t(harnessLabels[field.name as keyof typeof harnessLabels]),
        choices:field.choices.map(choice=>!choice.value&&board?{...choice,label:t('modelDefaults.inheritHarness')}:choice),
    }));
    if(!fields.length)throw Object.assign(new Error('Harness settings unavailable'),{code:'KANBAN_HARNESS_UNAVAILABLE'});
    return {fields};
}

function harnessFields(board:BoardSettingsState,catalog:KanbanBoardSettingsCatalog):DocumentFragment {
    const fragment=document.createDocumentFragment();
    for(const field of catalog.fields){
        const row=document.createElement('div'), label=document.createElement('label'), select=document.createElement('select');
        row.className='model-defaults__row';select.className='settings-form__select';
        label.textContent=field.label;label.htmlFor=select.id='kanban-harness-'+randomUUID();
        select.name='setting-'+field.name;
        const selected=board.settings?.[field.name]??'';
        for(const choice of field.choices){
            const option=new Option(choice.label,choice.value,false,choice.value===selected);
            option.disabled=!!choice.disabled&&choice.value!==selected;
            select.add(option);
        }
        row.append(label,select);fragment.append(row);
    }
    return fragment;
}
