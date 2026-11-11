import {createModuleLogger,randomUUID, sha256HexSync} from '@nestos/common';
import type {GitJournal as PromptJournal} from './contracts';
import {failure} from './errors';
import {gitWorkspace, type RepositoryEvidence} from './worktree-modules';
import type {GitProcess as RemoteProcessHandle} from './contracts';
const log=createModuleLogger('kanban-commit-context');
export interface CommitContext {
    schema: 'nestos.commit-context/1'; scopeId: string; projectId: string; boardId: string; itemId: string;
    itemRevision: number; executionId: string; digest: string; input: unknown; trailers: string;
}
export async function freezeCommitContext(journal: PromptJournal, input: {projectId: string; boardId: string; itemId: string; itemRevision: number; executionId: string; context: unknown}): Promise<CommitContext> {
    const started=Date.now();
    const key = 'development-commit-context:' + input.executionId, old = await journal.get<CommitContext>(key);
    if (old) {
        if (old.projectId !== input.projectId || old.boardId !== input.boardId || old.itemId !== input.itemId) throw failure('COMMIT_CONTEXT_SCOPE_CHANGED');
        await journal.update<CommitContext>('commit-context:' + old.digest, previous => previous ?? old); return old;}
    if ([input.projectId, input.boardId, input.itemId, input.executionId].some(value => !value || /[\r\n]/.test(value))) throw failure('COMMIT_CONTEXT_INVALID');
    const scopeId = await journal.update<string>('kanban-context-scope', value => value ?? randomUUID());
    const value = {schema: 'nestos.commit-context/1' as const, scopeId, projectId: input.projectId, boardId: input.boardId,
        itemId: input.itemId, itemRevision: input.itemRevision, executionId: input.executionId, input: commitInput(input.context)};
    const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if(bytes>49152){log.warn('Commit context rejected',{operation:'kanban.commit-context',operationId:input.executionId,stage:'freeze',result:'failure',code:'COMMIT_CONTEXT_LIMIT',bytes,limit:49152,durationMs:0});throw failure('COMMIT_CONTEXT_LIMIT');}
    const digest = sha256HexSync(JSON.stringify(value));
    const trailers = Object.entries({'NestOS-Scope': scopeId, 'NestOS-Board': input.boardId, 'NestOS-Task': input.itemId,
        'NestOS-Execution': input.executionId, 'NestOS-Context': 'sha256:' + digest}).map(([key, value]) => key + ': ' + value).join('\n') + '\n';
    const saved = await journal.update<CommitContext>(key, previous => previous ?? {...value, digest, trailers});
    await journal.update<CommitContext>('commit-context:' + saved.digest, previous => previous ?? saved);
    log.info('Commit provenance frozen',{operation:'kanban.commit-context',operationId:input.executionId,stage:'freeze',result:'success',bytes,durationMs:Date.now()-started});
    return saved;
}
export function parseCommitTrailers(text: string): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    for (const line of text.split('\n')) {
        const match = /^(NestOS-(?:Scope|Board|Task|Execution|Context)): (.+)$/.exec(line.trim());
        if (match) {if (Object.hasOwn(result, match[1])) throw failure('COMMIT_TRAILERS_AMBIGUOUS'); result[match[1]] = match[2];}
    }
    return result;
}
export async function verifyCommitContexts(process: RemoteProcessHandle, directory: string, repositories: RepositoryEvidence[], context: CommitContext): Promise<Array<{repository: string; commits: string[]}>> {
    const records = [];
    for (const repo of repositories) {
        const cwd = repo.path === '.' ? directory : directory + '/' + repo.path;
        const integrated = await integratedCommits(process, repo);
        const text = (await gitWorkspace(process, cwd, ['log', '--max-count=257', '--format=%H%x00%(trailers:only,unfold)%x00', repo.baseCommit + '..' + repo.head, '--'])).stdout;
        const parts = text.split('\0'), commits: string[] = []; let inspected = 0;
        for (let index = 0; index + 1 < parts.length; index += 2) {
            const sha = parts[index].trim(); if (!sha) continue;
            if (++inspected > 256) throw failure('COMMIT_CONTEXT_LIMIT');
            if (integrated.has(sha)) continue;
            const actual = parseCommitTrailers(parts[index + 1]);
            for (const [key, value] of Object.entries(parseCommitTrailers(context.trailers))) if (actual[key] !== value) throw failure('COMMIT_TASK_CONTEXT_MISMATCH');
            if (!/^[a-f0-9]{40,64}$/.test(sha)) throw failure('COMMIT_CONTEXT_INVALID'); commits.push(sha);
        }
        records.push({repository: repo.path, commits});
    }
    return records;
}
/** Imported target history belongs to the project, not to the current task. */
async function integratedCommits(process: RemoteProcessHandle, repo: RepositoryEvidence): Promise<Set<string>> {
    const cwd = repo.path === '.' ? '/workspace' : '/workspace/' + repo.path;
    const target = repo.path === '.' ? 'HEAD' : /^160000 commit ([a-f0-9]{40,64})\t/.exec(
        (await gitWorkspace(process, '/workspace', ['ls-tree', 'HEAD', '--', repo.path])).stdout)?.[1];
    if (!target) throw failure('COMMIT_TARGET_REPOSITORY_MISSING');
    const rows = (await gitWorkspace(process, cwd, ['log', '--max-count=257', '--format=%H', repo.baseCommit + '..' + target, '--'])).stdout.trim().split('\n').filter(Boolean);
    if (rows.length > 256) throw failure('COMMIT_CONTEXT_LIMIT');
    return new Set(rows);
}

/** Provenance needs this task and decision, not planner candidates or execution payloads. */
function commitInput(context:unknown):unknown {
    const value=context as {board?:unknown;task?:unknown;decision?:unknown}|null;
    return value?{...(value.board===undefined?{}:{board:value.board}),...(value.task===undefined?{}:{task:value.task}),...(value.decision===undefined?{}:{decision:value.decision})}:null;
}
