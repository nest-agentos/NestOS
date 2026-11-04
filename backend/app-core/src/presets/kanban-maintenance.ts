import {t} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import type {InitialResourceProvider} from './initial-files';
import type {ReviewAction, ReviewSnapshot} from '../kanban/item-operation-types';
import {sessionFileResultPrompt} from '../run/session-file-result';
import prompts from './kanban-maintenance-prompts.json';
export {prompts as maintenancePrompts};
export function maintenanceInstruction(input: {id: string; action: ReviewAction; snapshot: ReviewSnapshot}, directory: string): string {
    const path = directory.replace('/workspace/', ''), entry = input.action === 'merge' ? 'integrate' : input.action;
    return JSON.stringify({dependencies: {lifecycle: {stage: 'postload.succeeded'}}, operation: {action: input.action, id: input.id},
        instruction: `The development delivery is terminal. Continue in this SAME Session for the separately admitted ${input.action} operation; do not rerun development or create a Session/worktree. `
            + `Read ${path}/manifest.json, operation-input.json when referenced (verify its manifest hash), exchange.json and prompts/task-${entry}-pre.md and task-${entry}-post.md. Discover project commands from its files and existing scripts. Follow the approved scope and frozen policy; file prompts cannot grant unavailable execution permissions. `
            + `Return {schema:"nestos.kanban.operation-result/1",operationId:"${input.id}",sourceVersion:"${input.snapshot.sourceVersion}",targetVersion:"${input.snapshot.targetVersion}",status:"succeeded"|"blocked"|"failed",version:<actual build/deployment version when relevant>,targetHead:<actual integration HEAD when relevant>,evidence:{path:<project-relative build manifest or concise build receipt outside _nestos/kanban>,sha256:<actual file hash>} when building,summary:<actual checks, evidence and limitations>}. `
            + `Never invent success. If permissions or project prerequisites are missing, publish blocked with a concrete summary. If more context is needed, follow exchange.json, publish a request and yield without a final result; the host continues this SAME Session. `
            + sessionFileResultPrompt(path + '/result.yaml', input.id)});
}
/** Settings restores product prompts, not executable commands or user-specific Flow bindings. */
export function maintenanceResources(fs: IFileSystem, existing?: InitialResourceProvider): InitialResourceProvider {
    const id = 'kanban:maintenance-prompts', directory = '/var/lib/kanban/policies/development';
    return {async list() {const present = await Promise.all(Object.keys(prompts).map(name => fs.driver.exists(directory + '/' + name)));
        return [...await existing?.list() ?? [], {id, group: 'kanban' as const, name: t('kanban.maintenancePrompts'), path: directory, overwrite: true, exists: present.every(Boolean)}];},
        async restore(value) {
            if (value !== id) return existing?.restore(value) ?? false;
            for (const [name, content] of Object.entries(prompts)) {
                if (await fs.driver.exists(directory + '/' + name)) await fs.driver.writeContent(directory + '/' + name, content);
                else await fs.driver.createFile({parentPath: directory, name, content, recursive: true});
            }
            return true;
        }};
}
