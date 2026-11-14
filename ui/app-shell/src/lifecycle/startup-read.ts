import {decisionSort,DECISION_SORT_PREFERENCE_KEY} from '@nestos/kanban/contracts';
import type {StartupReadRequest} from '@nestos/app-contracts/services';

export function initialReadRequest(route:{slug:string;resource?:string}):StartupReadRequest {
    const request:StartupReadRequest={documents:['theme','nestos_assistant_menu_v1'],eventBaseline:true};
    const parts=route.resource?.split('/')??[];
    if(route.slug!=='kanban'||parts[1]!=='board'||parts[3]!=='@decision'||parts.length!==4)return request;
    try {
        let sort:import('@nestos/kanban/contracts').DecisionSort='activity-desc';
        try{sort=decisionSort(globalThis.localStorage?.getItem(DECISION_SORT_PREFERENCE_KEY));}catch{/* UI uses the same fallback when preference storage is unavailable. */}
        request.decision={boardId:decodeURIComponent(parts[2]),query:{sort,attentionOnly:false,archived:false,sections:['page','catalog','projects'],locale:globalThis.navigator?.language}};
    }catch{/* Invalid resource identities are reported by the workspace loader. */}
    return request;
}
