import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {withTemporaryScope, processOutput} from '../tools/temporary-process/node/index.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, 'nestos/temporary-process')
    : join(root, '_nestos/tmp/performance-processes');
const suites = {
    budget: ['node', ['--test', 'scripts/tests/performance-budget.test.mjs']],
    core: ['pnpm', ['--filter', '@nestos/app-core', 'exec', 'vitest', 'run', '--fileParallelism=false',
        'tests/host/session-view.test.ts', 'tests/host/session-performance.test.ts', 'tests/session-browser.test.ts',
        'tests/digital-twin-view.test.ts', 'tests/assistant-session-projection.test.ts', 'tests/kanban-session-source.test.ts', 'tests/kanban-session-resource.test.ts', 'tests/session-resource.test.ts', 'tests/recovery-index-performance.test.ts']],
    transport: ['pnpm', ['--filter', '@nestos/http-app', 'exec', 'vitest', 'run', '--fileParallelism=false', 'tests/view-performance.test.ts', 'tests/json-compression.test.ts']],
    ui: ['pnpm', ['--filter', '@nestos/app-shell', 'exec', 'vitest', 'run', '--fileParallelism=false',
        'tests/digital-twin-view.test.ts', 'tests/kanban-catalog.test.ts', 'tests/lazy-settings-editors.test.ts',
        'tests/bootstrap-navigation-cleanup.test.ts', 'tests/navigation-timing.test.ts', 'tests/kanban-windows.test.ts',
        'tests/study-save-destination.test.ts', 'tests/session-editor-load.test.ts', 'tests/navigation-performance.test.ts']],
};
function summarizeChecks(output) {
    return output.split(/\r?\n/).map(line => line.trim())
        .filter(line => /^(?:Test Files|Tests|Duration)\s{2,}\d|^ℹ (?:tests|pass|fail|cancelled|skipped|todo) \d+$/.test(line))
        .slice(-8);
}
async function main() {
    const selection = process.argv.slice(2);
    if (selection.some(name => !Object.hasOwn(suites, name))) throw new Error('PERFORMANCE_SUITE_INVALID');
    const names = selection.length ? [...new Set(['budget', ...selection])] : Object.keys(suites);
    const scopeId = 'performance-' + randomUUID();
    console.log(JSON.stringify({operation: 'performance.regression', stage: 'start', scopeId, directory}));
    await withTemporaryScope({scopeId, directory, log: event => console.log(JSON.stringify(event))}, async scope => {
        for (const name of names) {
            const [command, args] = suites[name];
            const started = performance.now();
            const result = await (await scope.start(command, args, {cwd: root, timeoutMs: 180000})).result;
            const output = await processOutput(directory, result.id);
            console.log(JSON.stringify({suite:name,outcome:result.outcome,exitCode:result.exitCode,durationMs:Math.round(performance.now()-started),
                recordId:result.id,outputBytes:output.outputBytes,checks:summarizeChecks(output.output)}));
            if (result.outcome !== 'succeeded') {
                process.stderr.write(output.output.slice(-8192)+'\n');
                throw new Error('PERFORMANCE_SUITE_FAILED');
            }
        }
    });
    console.log(JSON.stringify({operation: 'performance.regression', scopeId, result: 'success', cleanup: 'confirmed'}));
}
void main().catch(error => {console.error(JSON.stringify({operation: 'performance.regression', result: 'failure', code: error.message})); process.exitCode = 1;});
