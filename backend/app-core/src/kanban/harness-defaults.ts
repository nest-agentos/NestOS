import {createModuleLogger, randomUUID} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanHarnessDefaults, SaveKanbanHarnessDefaults} from '@nestos/app-contracts/settings';
import {safeCode} from '@nestos/kanban/integration';
import {harnessRoles, readHarnessChoice, type ReadHarnessDefault, type kanbanHarnessSettings} from '../presets/kanban-harness-settings';
import type {KanbanBoard, KanbanBoardSettingsCatalog} from '@nestos/kanban/contracts';
import {requireValue} from './validation';

const path = '/var/lib/kanban/harness-defaults.seq', entry = 'defaults';
const log = createModuleLogger('kanban-harness-defaults');
type RecordValue = KanbanHarnessDefaults & {operationId?: string};
const decode = (raw?: string | null): RecordValue => raw ? JSON.parse(raw) : {revision:0, settings:{}};
const defaults = ({revision,settings}:RecordValue):KanbanHarnessDefaults => ({revision,settings});

export function kanbanHarnessDefaults(fs:IFileSystem, policy:ReturnType<typeof kanbanHarnessSettings>) {
    const seq = fs.meta.seq!;
    const read = async () => decode(await fs.driver.exists(path) ? await seq.getEntry(path,entry) : null);
    const preferred:ReadHarnessDefault = async role => readHarnessChoice(role,(await read()).settings);

    async function forBoard(board:Pick<KanbanBoard,'settings'>):Promise<KanbanBoardSettingsCatalog> {
        const [catalog,global]=await Promise.all([policy.catalog(board),read()]);
        const harnessDefaults:NonNullable<KanbanBoardSettingsCatalog['harnessDefaults']>={harnesses:{},models:{}};
        for(const role of harnessRoles){
            const choice=readHarnessChoice(role,board.settings)??readHarnessChoice(role,global.settings);
            if(!choice)continue;
            harnessDefaults.harnesses[role]=choice.profileId;
            if(choice.selection)harnessDefaults.models[role]=choice.selection;
        }
        return {...catalog,harnessDefaults};
    }

    async function readKanbanHarnessDefaults() {
        const operationId=randomUUID(), started=Date.now(); let stage='read';
        try {
            const result=defaults(await read());
            stage='catalog'; const catalog=await policy.catalog(result);
            log.debug('kanban.harness.defaults',{operationId,stage,result:'success',count:catalog.fields.length,durationMs:Date.now()-started});
            return {...result,catalog};
        } catch(error) { reportFailure(operationId,stage,started,error); throw error; }
    }

    async function saveKanbanHarnessDefaults(input:SaveKanbanHarnessDefaults):Promise<KanbanHarnessDefaults> {
        const started=Date.now(), operationId=validId(input?.operationId)?input.operationId:randomUUID(); let stage='validate';
        try {
            validateRequest(input);
            input=structuredClone(input);
            stage='read-current'; const current=await read();
            if(replay(current,input))return defaults(current);
            requireValue(current.revision===input.revision,'CONFLICT');
            stage='catalog-validate'; await policy.validate(current,input.settings);
            stage='persist'; await ensureStore(fs);
            const result=await seq.transaction!(async tx=>{
                const prior=decode(await tx.getEntry(path,entry));
                if(replay(prior,input))return defaults(prior);
                requireValue(prior.revision===input.revision,'CONFLICT');
                const next={revision:input.revision+1,settings:input.settings,operationId};
                await tx.setEntry(path,entry,JSON.stringify(next));
                return defaults(next);
            });
            log.info('kanban.harness.defaults',{operationId,stage,result:'success',revision:result.revision,durationMs:Date.now()-started});
            return result;
        } catch(error) { reportFailure(operationId,stage,started,error); throw error; }
    }
    return {preferred,forBoard,api:{readKanbanHarnessDefaults,saveKanbanHarnessDefaults,readKanbanHarnessModels:policy.modelsForDefaults}};
}

const validId = (id:unknown):id is string => typeof id==='string' && /^[\w-]{1,128}$/.test(id);
function validateRequest(input:SaveKanbanHarnessDefaults):void {
    requireValue(input && validId(input.operationId) && Number.isSafeInteger(input.revision) &&
        input.revision>=0 && input.revision<Number.MAX_SAFE_INTEGER,'INVALID_BOARD_SETTINGS');
    const settings=input.settings;
    requireValue(settings && typeof settings==='object' && !Array.isArray(settings) && Object.keys(settings).length<=6 &&
        Object.values(settings).every(value=>typeof value==='string'&&value.length<=1024),'INVALID_BOARD_SETTINGS');
}

function replay(current:RecordValue,input:SaveKanbanHarnessDefaults):boolean {
    if(current.operationId!==input.operationId)return false;
    requireValue(current.revision===input.revision+1 && Object.keys(current.settings).length===Object.keys(input.settings).length &&
        Object.entries(input.settings).every(([key,value])=>current.settings[key]===value),'IDEMPOTENCY_CONFLICT');
    return true;
}

async function ensureStore(fs:IFileSystem):Promise<void> {
    if(await fs.driver.exists(path))return;
    try {await fs.driver.createFile({parentPath:'/var/lib/kanban',name:'harness-defaults.seq',type:'seqfile',recursive:true});}
    catch(error) {if(safeCode(error,'')!=='EEXIST')throw error;}
}

function reportFailure(operationId:string,stage:string,started:number,error:unknown):void {
    log.warn('kanban.harness.defaults',{operationId,stage,result:'failure',code:safeCode(error,'KANBAN_HARNESS_DEFAULTS_FAILED'),durationMs:Date.now()-started});
}
