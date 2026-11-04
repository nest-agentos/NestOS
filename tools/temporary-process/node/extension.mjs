import {failure} from './identity.mjs';
import {claimOperation} from './operation.mjs';
import {temporaryScope, processOutput, recover} from './index.mjs';
export async function createTools({buildTool, z}) {
    if (process.platform === 'linux') await recover(undefined, event => console.info('[TemporaryProcess]', JSON.stringify(event)));
    const scopes = new Set(); let stopping = false;
    return [buildTool({name: 'temporary.run', version: '1', maxResultSizeChars: 512 * 1024, isReadOnly: () => false,
        searchHint: 'Run bounded temporary validation commands and reclaim their process group',
        inputSchema: z.object({command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().optional(), timeoutMs: z.number().int().min(1).max(3600000).default(600000)}),
        interruptBehavior: () => 'cancel',
        async description() {return 'Run temporary build/test/preview commands in an owned scope. Reap the complete process group on completion, cancellation, timeout or owner death. Nested sessions remain contained in the temporary PID namespace. Not for persistent deployments or resumable Agent Sessions.';},
        async prompt() {return this.description();},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};},
        async call(args, context) {
            if (process.platform !== 'linux') throw failure('TEMP_PROCESS_UNSUPPORTED');
            if (stopping) throw failure('TEMP_PROCESS_STOPPING');
            const admission = await claimOperation(context.operationId, args); if (admission.existing) return {data: admission.existing};
            const scope = await temporaryScope({scopeId: context.operationId, signal: context.signal, log: event => context.record?.(event)}); scopes.add(scope);
            try {
                if (stopping) throw failure('TEMP_PROCESS_STOPPING');
                const child = await scope.start(args.command, args.args, {cwd: args.cwd, timeoutMs: args.timeoutMs, resourceId: admission.resourceId}), result = await child.result;
                return {data: {...result, ...await processOutput(undefined, child.id)}};
            } finally {await scope.close(); scopes.delete(scope);}
        },
        async dispose() {stopping = true; const results = await Promise.allSettled([...scopes].map(scope => scope.close())); if (results.some(row => row.status === 'rejected')) throw failure('TEMP_PROCESS_CLEANUP_UNCONFIRMED');},
    })];
}
