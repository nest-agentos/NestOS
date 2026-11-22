import {decisionSort,DECISION_SORT_PREFERENCE_KEY,DEFAULT_DECISION_SORT} from '@nestos/kanban/contracts';
import type {StartupReadRequest} from '@nestos/app-contracts/services';
import {MOBILE_NAVIGATION_QUERY} from '@nestos/ui-common';

export function initialReadRequest(route:{slug:string;resource?:string}):StartupReadRequest {
    const request:StartupReadRequest={documents:['theme','nestos_assistant_menu_v1'],eventBaseline:true};
    const parts=route.resource?.split('/')??[];
    if(route.slug!=='kanban'||parts[1]!=='board'||!parts[2]||!parts[3]||parts.length!==4)return request;
    try {
        if(!parts[3].startsWith('@')){
            const itemId=decodeURIComponent(parts[3]);
            if(!itemId.startsWith('@'))request.task={boardId:decodeURIComponent(parts[2]),itemId,
                ...(globalThis.matchMedia?.(MOBILE_NAVIGATION_QUERY).matches?{includeSidebar:false}:{})};
            if(request.task)request.documents=['theme'];
            return request;
        }
        if(parts[3]!=='@decision')return request;
        let sort=DEFAULT_DECISION_SORT;
        try{sort=decisionSort(globalThis.localStorage?.getItem(DECISION_SORT_PREFERENCE_KEY));}catch{/* UI uses the same fallback when preference storage is unavailable. */}
        request.decision={boardId:decodeURIComponent(parts[2]),query:{sort,attentionOnly:false,archived:false,sections:['page','catalog','projects'],locale:globalThis.navigator?.language}};
    }catch{/* Invalid resource identities are reported by the workspace loader. */}
    return request;
}
