#!/usr/bin/env node
import {withTemporaryScope, processOutput, recover} from './index.mjs';
function options(args) {
    const separator = args.indexOf('--'), flags = separator < 0 ? args : args.slice(0, separator), result = {};
    for (let i = 0; i < flags.length; i += 2) {
        const key = {'--registry': 'directory', '--scope': 'scopeId', '--timeout-ms': 'timeoutMs', '--cwd': 'cwd'}[flags[i]];
        if (!key || !flags[i + 1]) throw new Error('TEMP_PROCESS_INVALID_OPTIONS'); result[key] = key === 'timeoutMs' ? Number(flags[i + 1]) : flags[i + 1];
    }
    return {...result, command: separator < 0 ? [] : args.slice(separator + 1)};
}
const [action, ...args] = process.argv.slice(2);
try {
    const config = options(args);
    if (action === 'recover') {const results = await recover(config.directory); console.log(JSON.stringify(results)); if (results.some(row => row.state === 'unknown')) process.exitCode = 1;}
    else if (action === 'run' && config.command.length) {
        const result = await withTemporaryScope({directory: config.directory, scopeId: config.scopeId}, async scope =>
            (await scope.start(config.command[0], config.command.slice(1), {cwd: config.cwd, timeoutMs: config.timeoutMs})).result);
        console.log(JSON.stringify({...result, ...await processOutput(config.directory, result.id)})); process.exitCode = result.outcome === 'succeeded' ? 0 : 1;
    } else throw Object.assign(new Error('Usage: run [--scope id] [--timeout-ms n] [--registry path] -- command [args] | recover [--registry path]'), {code: 'TEMP_PROCESS_USAGE'});
} catch (error) {console.error(JSON.stringify({code: error.code ?? 'TEMP_PROCESS_INVALID_OPTIONS'})); process.exitCode = 1;}
