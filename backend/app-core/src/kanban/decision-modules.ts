import type {KanbanDecisionModule,KanbanExternalReference} from '@nestos/kanban/contracts';
import {requireValue} from './validation';

const system='nestos-decision-module';
export const decisionModuleReference=(module:KanbanDecisionModule):KanbanExternalReference=>({system,id:module.id,revision:module.version});

export function resolveDecisionModules(catalog:readonly KanbanDecisionModule[]|undefined,ids:readonly string[]):KanbanDecisionModule[] {
    return ids.map(id=>{
        const candidates=catalog?.filter(module=>module.id===id);
        requireValue(candidates?.length===1,'DECISION_MODULE_UNAVAILABLE');
        return candidates[0];
    });
}

export function hasDecisionModule(refs:readonly KanbanExternalReference[]|undefined,module:KanbanDecisionModule):boolean {
    return refs?.some(ref=>ref.system===system&&ref.id===module.id&&ref.revision===module.version)??false;
}

export interface KanbanApprovalModule extends KanbanDecisionModule {
    decide(context:{projectId:string;profileId:string;cwd:string|null;request:Record<string,unknown>}):
        {decision:'allow'}|{decision:'manual';code:string};
}

export function usesSoftwareModule(record:Pick<import('@nestos/kanban/contracts').KanbanProjectRecord,'externalRefs'>|undefined):boolean {
    return record?.externalRefs?.some(ref=>ref.system===system&&ref.id==='software-development')===true;
}
