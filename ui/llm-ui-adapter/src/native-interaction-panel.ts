import {createInteractionCard,type InteractionCard,type InteractionResponse} from '@nestos/llm-ui';
import {createModuleLogger,randomUUID,t} from '@nestos/common';
import {nativeInteraction,nativeResponse} from './native-interactions';
import type {ConversationRequest,ConversationSnapshot} from './contracts';

type Snapshot=Pick<ConversationSnapshot,'requests'|'canRespond'|'disconnected'|'observation'>;
export interface NativeInteractionControls {
    read():Promise<Snapshot>;refresh():Promise<Snapshot>;snapshot():Snapshot;
    respond(id:string|number,response:Record<string,unknown>):Promise<Snapshot>;
    subscribe(listener:()=>void):()=>void;
}
const log=createModuleLogger('session-interactions');
const identity=(request:ConversationRequest)=>`${typeof request.id}:${request.id}`;
const fingerprint=(request:ConversationRequest)=>JSON.stringify({...request,responding:undefined});
/** Both this panel and the chat editor use native cards and the original durable response port. */
export class NativeInteractionPanel {
    private closed=false;
    private timer?:ReturnType<typeof setTimeout>;
    private stop?:()=>void;
    private readonly feedback=document.createElement('p');
    private readonly cards=new Map<string,{encoded:string;card:InteractionCard}>();
    constructor(private readonly container:HTMLElement,private readonly controls:NativeInteractionControls){}
    async start():Promise<void>{
        const operationId=randomUUID(),started=Date.now();
        this.feedback.setAttribute('role','alert');this.container.append(this.feedback);
        this.stop=this.controls.subscribe(()=>this.render(this.controls.snapshot()));
        try{
            const state=await this.controls.read();this.render(state);this.schedule();
            log.info('session.interaction.read',{operationId,stage:'native.read',result:this.closed?'superseded':'success',requestCount:state.requests.length,durationMs:Date.now()-started});
        }catch(error){this.destroy();log.warn('session.interaction.read',{operationId,stage:'native.read',result:'failure',code:safeCode(error),durationMs:Date.now()-started});throw error;}
    }
    destroy():void {this.closed=true;clearTimeout(this.timer);this.stop?.();for(const row of this.cards.values())row.card.destroy();this.cards.clear();this.feedback.remove();}
    private render(state:Snapshot):void {
        if(this.closed)return;
        this.availability(state);
        const ids=new Set(state.requests.map(identity));
        for(const [id,row] of this.cards)if(!ids.has(id)){row.card.destroy();this.cards.delete(id);}
        this.container.querySelector('[data-interactions-empty]')?.remove();
        for(const request of state.requests){
            const id=identity(request),encoded=fingerprint(request);let row=this.cards.get(id);
            if(row?.encoded!==encoded){
                row?.card.destroy();
                const card=createInteractionCard(nativeInteraction(request),response=>this.respond(request,response));
                row={encoded,card};this.cards.set(id,row);this.container.append(card.element);
            }
            row.card.setPending(!state.canRespond||state.disconnected||!!state.observation?.stale||!!request.responding);
        }
        if(!ids.size){const empty=document.createElement('p');empty.dataset.interactionsEmpty='';empty.setAttribute('role','status');empty.textContent=t('kanban.sessionInteractionsEmpty');this.container.append(empty);}
    }
    private availability(state:Snapshot):void {
        const pending=state.requests.some(request=>request.responding);
        const unavailable=state.requests.length&&(!state.canRespond||state.disconnected||state.observation?.stale);
        if(pending||unavailable){this.feedback.dataset.availability='true';this.feedback.textContent=t(pending?'kanban.interactionReceiptPending':'kanban.interactionUnavailable');}
        else if(this.feedback.dataset.availability){delete this.feedback.dataset.availability;this.feedback.textContent='';}
    }
    private async respond(request:ConversationRequest,response:InteractionResponse):Promise<void>{
        if(this.closed)throw new Error(t('kanban.interactionChanged'));
        const operationId=randomUUID(),started=Date.now();
        try{
            const latest=await this.controls.refresh();validateResponse(request,latest,this.closed);
            const result=await this.controls.respond(request.id,nativeResponse(response));this.render(result);
            const pending=result.requests.some(row=>identity(row)===identity(request));
            log.info('session.interaction.respond',{operationId,stage:'native.respond',result:pending?'pending':'success',durationMs:Date.now()-started});
            if(pending)throw Object.assign(new Error(t('kanban.interactionReceiptPending')),{code:'INTERACTION_RECEIPT_PENDING'});
            this.feedback.textContent='';
        }catch(error){this.render(this.controls.snapshot());if(!this.closed)this.feedback.textContent=responseError(error);log.warn('session.interaction.respond',{operationId,stage:'native.respond',result:'failure',code:safeCode(error),durationMs:Date.now()-started});throw new Error(responseError(error));}
    }
    private schedule():void {if(!this.closed)this.timer=setTimeout(()=>{void this.poll();},5000);}
    private async poll():Promise<void>{
        const started=Date.now();
        try{this.render(await this.controls.refresh());}
        catch(error){log.warn('session.interaction.observe',{operationId:randomUUID(),stage:'native.refresh',result:'failure',code:safeCode(error),durationMs:Date.now()-started});for(const row of this.cards.values())row.card.setPending(true,t('kanban.interactionUnavailable')+' · '+safeCode(error));}
        finally{this.schedule();}
    }
}
function safeCode(error:unknown):string {const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'INTERACTION_FAILED';}
function responseError(error:unknown):string {const code=safeCode(error);return t(code==='STALE_REQUEST'?'kanban.interactionChanged':code==='INTERACTION_RECEIPT_PENDING'?'kanban.interactionReceiptPending':'kanban.interactionUnavailable')+' · '+code;}

function validateResponse(request:ConversationRequest,latest:Snapshot,closed:boolean):void {
    const current=latest.requests.find(row=>identity(row)===identity(request));
    if(closed||!current||fingerprint(current)!==fingerprint(request))throw Object.assign(new Error(t('kanban.interactionChanged')),{code:'STALE_REQUEST'});
    if(!latest.canRespond||latest.disconnected||latest.observation?.stale||current.responding)throw Object.assign(new Error(t('kanban.interactionUnavailable')),{code:'INTERACTION_UNAVAILABLE'});
}
