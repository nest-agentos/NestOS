import {randomUUID} from '@nestos/common';
import {writeCallJson} from './application-submission';
import {readFile} from 'node:fs/promises';
import type {ApplicationClient} from '@nestos/app-contracts/services';
import type {CommandOptions} from './commands';

type Service = NonNullable<ApplicationClient['services']['kanban']>;

/** Frozen requests retain their operation IDs and revisions across transport failures. */
export async function kanbanCommand(client: ApplicationClient, args: string[], options: CommandOptions): Promise<unknown> {
    const service = client.services.kanban;
    if (!service) throw Object.assign(new Error('Kanban is unavailable on this host'), {code: 'ECAPABILITY'});
    if (args[0] === 'task') return taskCommand(service, args.slice(1), options);
    const [action, boardId, itemId] = args;
    if (action === 'list') return service.catalog();
    if (action === 'resolve' && boardId) return service.resolve(boardId);
    if (action === 'principal') return service.currentPrincipal();
    if (action === 'resources' && service.recordResources) return service.recordResources();
    if (action === 'create') return service.create(await jsonFile<Parameters<Service['create']>[0]>(options.file));
    if (action === 'targets') {
        if (!service.automationCatalog) throw Object.assign(new Error('Kanban automation requires a newer host'), {code: 'ECAPABILITY'});
        return service.automationCatalog();
    }
    if (!boardId) throw new Error('Missing board id');
    if (action === 'fix' && service.fixTask) return service.fixTask(boardId,await jsonFile<Parameters<NonNullable<Service['fixTask']>>[1]>(options.file));
    if (action === 'reply' && service.replyTask) return service.replyTask(boardId,await jsonFile<Parameters<NonNullable<Service['replyTask']>>[1]>(options.file));
    if (action === 'query') return service.query(boardId,options.file?await jsonFile(options.file):{view:'all'});
    if (action === 'item-resources' && service.itemResources) return service.itemResources(boardId, itemId);
    if (action === 'show') return service.read(boardId);
    if (action === 'work-resources' && itemId && service.workResources) return service.workResources(boardId, itemId);
    if (action === 'cleanup-work-resource' && service.cleanupWorkResource) return service.cleanupWorkResource(boardId, await jsonFile<Parameters<NonNullable<Service['cleanupWorkResource']>>[1]>(options.file));
    if (action === 'workflow') return service.workflow(boardId);
    if (action === 'records') return service.records(boardId);
    if (action === 'events') return service.events(boardId, itemId ? integer(itemId) : undefined);
    if (action === 'execute') return service.execute(boardId, await jsonFile<Parameters<Service['execute']>[1]>(options.file));
    if (action === 'continue') {
        const request = await jsonFile<Parameters<Service['execute']>[1]>(options.file);
        if (request.command?.type !== 'continue-execution') throw new Error('kanban continue requires a frozen continue-execution request');
        return service.execute(boardId, request);
    }
    if (action === 'analysis' && itemId && service.analysisStatus) return service.analysisStatus(boardId, itemId);
    if (action === 'item' && itemId) return service.item(boardId, itemId);
    if (action === 'sessions' && itemId) {
        if (!service.executionSession) throw Object.assign(new Error('Session relations require a newer host'), {code: 'ECAPABILITY'});
        return service.executionSession(boardId, itemId, {includeRelated: true});
    }
    if (action === 'record' && itemId) return service.record(boardId, itemId);
    if (action === 'runs' && itemId && service.recordExecutions) return service.recordExecutions(boardId, itemId);
    if (action === 'record-control' && service.controlRecord) return service.controlRecord(boardId,await jsonFile<Parameters<NonNullable<Service['controlRecord']>>[1]>(options.file));
    if (action === 'run' && service.runRecord) return service.runRecord(boardId, await jsonFile<Parameters<NonNullable<Service['runRecord']>>[1]>(options.file));
    throw new Error('kanban requires list/principal/create/targets/show/workflow/records/events/execute/item/record');
}

export async function jsonFile<T>(path?: string): Promise<T> {
    if (!path) throw new Error('Missing --file JSON request');
    const bytes = await readFile(path);
    if (bytes.byteLength > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be a JSON object');
    return value as T;
}
function integer(value: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid event sequence');
    return number;
}


async function taskCommand(service: Service, args: string[], options: CommandOptions): Promise<unknown> {
    const [action, boardId, itemId, replacementId] = args;
    if (!['run', 'pause', 'resume', 'cancel', 'reopen', 'restart'].includes(action) || !boardId || !itemId || args.length !== (action === 'restart' ? 4 : 3))
        throw new Error('kanban task run|pause|resume|cancel|reopen|restart <board-id> <item-id> [replacement-id for restart] --submission-file request.json (or --file to submit the frozen request)');
    if (options.file && options.submissionFile) throw new Error('Choose --file or --submission-file');
    let request: Parameters<Service['execute']>[1];
    if (options.file) request = await jsonFile(options.file);
    else {
        if (!options.submissionFile) throw new Error('Missing --submission-file; save a stable task control request before dispatch');
        const board = await service.read(boardId);
        if (!board.items.some(item => item.id === itemId)) throw new Error('Kanban task was not found');
        request = {operationId: randomUUID(), expectedRevision: board.revision, command: action === 'run'
            ? {type: 'request-run', itemId} : action === 'restart' ? {type:'restart-item',itemId,replacementId} : action === 'reopen' ? {type: 'reopen-item', itemId, reopenId: randomUUID()} : {type: 'request-control', itemId, controlId: randomUUID(), action: action as 'pause' | 'resume' | 'cancel'}};
        await writeCallJson(options.submissionFile, request, request.operationId, 'kanban.task.' + action);
    }
    const command = request.command;
    if (command?.type !== (action === 'run' ? 'request-run' : action === 'reopen' ? 'reopen-item' : action === 'restart' ? 'restart-item' : 'request-control') || !('itemId' in command) || command.itemId !== itemId
        || !['run', 'reopen', 'restart'].includes(action) && (!('action' in command) || command.action !== action)) throw new Error('Frozen task request does not match the requested task or action');
    if (action === 'restart' && (command.type !== 'restart-item' || command.replacementId !== replacementId)) throw new Error('Frozen restart request does not match the replacement task');
    return service.execute(boardId, request);
}
