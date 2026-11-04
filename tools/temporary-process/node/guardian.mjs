import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {identity, failure, stopOwned} from './identity.mjs';
import {save} from './registry.mjs';
let worker, record, directory, stopping, timer, initialization, requested, disconnected = !process.connected;
const send = message => {if (process.connected) process.send(message, () => {});};
async function stop(reason, result = {}) {
    requested ??= {reason, result};
    if (stopping) return stopping;
    stopping = (async () => {
        await initialization?.catch(() => {});
        clearTimeout(timer);
        if (!record) return;
        try {
            await stopOwned(record); if (worker && !worker.killed && worker.connected) worker.disconnect();
            record = {...record, phase: 'closed', reason, result, closedAt: Date.now()}; await save(directory, record);
            send({type: 'closed', result: {id: record.id, reason, ...result}});
        } catch (error) {await save(directory, {...record, phase: 'unknown', code: error.code ?? 'TEMP_PROCESS_CLEANUP_UNCONFIRMED'}); send({type: 'failed', code: error.code ?? 'TEMP_PROCESS_CLEANUP_UNCONFIRMED'});}
        finally {if (worker?.connected) worker.disconnect(); if (process.connected) process.disconnect();}
    })(); return stopping;
}
async function start(message) {
    directory = message.directory; record = message.record;
    if (disconnected) return;
    worker = fork(fileURLToPath(new URL('worker.mjs', import.meta.url)), [], {detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {...process.env, NESTOS_TEMPORARY_PROCESS_TOKEN: record.token}});
    worker.once('error', error => {void stop('spawn-failed', {outcome: 'failed', code: error.code ?? 'TEMP_PROCESS_SPAWN_FAILED'});});
    worker.on('message', event => {if (event.type === 'started') send({type: 'ready', id: record.id}); if (event.type === 'result') {const {type, ...result} = event; void stop('command-ended', result);}});
    worker.once('exit', () => {if (!stopping) void stop('worker-ended', {outcome: 'failed', code: 'TEMP_PROCESS_WORKER_EXITED'});});
    record = {...record, worker: await identity(worker.pid), guardian: await identity(process.pid), phase: 'running'};
    if (!record.worker || record.worker.group !== record.worker.pid || record.worker.session !== record.worker.pid) throw failure('TEMP_PROCESS_WORKER_IDENTITY_MISSING');
    await save(directory, record);
    if (disconnected || requested || Date.now() >= record.expiresAt) {void stop('deadline', {outcome: 'timed-out'}); return;}
    timer = setTimeout(() => {void stop('deadline', {outcome: 'timed-out'});}, Math.max(1, record.expiresAt - Date.now()));
    worker.send({...message, type: 'start', output: join(directory, record.id + '.output.log')});
}
process.on('message', message => {
    if (message.type === 'start' && !initialization) {initialization = start(message); void initialization.catch(error => {send({type: 'failed', code: error.code ?? 'TEMP_PROCESS_START_FAILED'}); void stop('start-failed');});}
    if (message.type === 'stop') void stop('scope-ended', {outcome: 'cancelled'});
});
process.once('disconnect', () => {disconnected = true; void stop('owner-lost');});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {disconnected = true; void stop('guardian-stopped');});
if (disconnected) process.exit(1);
