import {resolveCommitRequest as resolveGitRequest,preloadCommitContexts as preloadGitContexts,selectHistorical,type CommitQueryOptions as GitOptions,type CommitRequest} from '@nestos/git-delivery/contexts';
import type {CommitContext} from '@nestos/git-delivery/provenance';
import type {KanbanService,KanbanItem} from '@nestos/kanban/contracts';
export interface CommitQueryOptions extends Omit<GitOptions,'currentContext'> {service:KanbanService}
export function resolveCommitRequest(options:CommitQueryOptions,request:CommitRequest):Promise<unknown> {return resolveGitRequest({...options,currentContext:(saved,include)=>currentContext(options,saved,include)},request);}
export function preloadCommitContexts(options:CommitQueryOptions):Promise<unknown> {return preloadGitContexts({...options,currentContext:(saved,include)=>currentContext(options,saved,include)});}
async function currentContext(options: CommitQueryOptions, saved: CommitContext, include: string[]): Promise<unknown> {
    let item: KanbanItem;
    try {item = (await options.service.item(saved.boardId, saved.itemId)).item;}
    catch (error) {if (['ITEM_NOT_FOUND', 'BOARD_NOT_FOUND'].includes((error as {code?: string})?.code ?? '')) return {unavailable: true}; throw error;}
    const decision = (saved.input as {decision?: {sourceBoardId: string; recordId: string}})?.decision;
    let record: unknown;
    if (decision && include.includes('decisions')) {try {record = await options.service.record(decision.sourceBoardId, decision.recordId);}
        catch (error) {if (!['RECORD_NOT_FOUND', 'BOARD_NOT_FOUND'].includes((error as {code: string}).code)) throw error;}}
    return selectHistorical({task: {id: item.id, revision: item.revision, status: item.status, title: item.title, responsibility: item.responsibility, acceptance: item.acceptance}, decision: record ?? null}, include);
}
