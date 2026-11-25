import {sessionRoute} from '@nestos/app-contracts';
import type {ApplicationBackend,ApplicationServices} from '@nestos/app-contracts/services';
import {randomUUID} from '@nestos/common';
import type {KanbanClient,KanbanItem} from '@nestos/kanban/contracts';

const discussionBranch = 'task-discussion';
const discussionId = (item:KanbanItem) => item.participants.find(p=>p.roles.includes('discussion'))?.sessionId;

export async function openTaskDiscussion(services:ApplicationServices,backend:ApplicationBackend,boardId:string,item:KanbanItem,context:string):Promise<string> {
    const existing=discussionId(item);
    if(existing&&await hasDiscussion(services,existing))return sessionRoute(existing,discussionBranch);
    const projectId=item.externalRefs?.find(ref=>ref.system==='nestos-remote-project')?.id;
    const project=projectId?await services.projects.get(projectId):await services.projects.personal();
    const id=existing??await reserveDiscussion(services.kanban!,boardId,item.id);
    await backend.createSessionDraft({sessionId:id,branchName:discussionBranch,title:item.title,inputText:context,source:{projectFolder:project.path}});
    return sessionRoute(id,discussionBranch);
}

async function hasDiscussion(services:ApplicationServices,id:string):Promise<boolean> {
    try {return Object.hasOwn((await services.sessionRepository.getManifest(id)).branches,discussionBranch);}
    catch(error){if(['ENOENT','SESSION_NOT_FOUND'].includes((error as {code?:string})?.code??''))return false; throw error;}
}

async function reserveDiscussion(service:KanbanClient,boardId:string,itemId:string):Promise<string> {
    const id=randomUUID();
    const [board,{item}]=await Promise.all([service.read(boardId),service.item(boardId,itemId)]);
    const existing=discussionId(item); if(existing)return existing;
    try {
        await service.execute(boardId,{expectedRevision:board.revision,operationId:id,
            command:{type:'register-session',itemId,sessionId:id,role:'discussion',subscribed:false}});
    } catch(error) {
        const latest=discussionId((await service.item(boardId,itemId)).item);
        if(latest)return latest;
        throw error;
    }
    return id;
}
