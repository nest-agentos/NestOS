import {randomUUID} from '@nestos/common';
import type {SubmissionRequest} from '@nestos/llm-session/contracts';
import {failure, type PromptJournal} from './prompt-bundle';
import type {createSessionSubmission as sessionSubmission, SessionSubmissionObservation} from '@nestos/llm-session';
import {channelDigest, type ChannelRequest, type ChannelResponse, type ChannelReply, type ChannelEnvelope} from './channel-protocol';
interface Turn {history?: Array<{id: string; requests: string[]}>; phase: 'idle' | 'prepared' | 'submitting'; consumed: string[]; requests?: string[]; request?: SubmissionRequest}
interface Receipt {digest: string; request: ChannelRequest; response?: ChannelResponse}
export interface ChannelExchangeOptions {
    finalPublished?: boolean | (() => Promise<boolean>);
    id: string; scopeId: string; readRequests(): Promise<ChannelEnvelope[]>; publishResponse(response: ChannelResponse): Promise<ChannelResponse>; journal: PromptJournal & {claim(key: string): Promise<boolean>};
    submission: ReturnType<typeof sessionSubmission>;
    resolve(request: ChannelRequest): Promise<unknown>;
    prepare(id: string, paths: ChannelReply[]): Promise<SubmissionRequest>;
    report?(stage: string, id: string, code?: string): Promise<void>;
}
/** Durable channel records carry requests and responses. A submitted continuation is only observed, never submitted twice. */
export async function advanceChannelExchange(options: ChannelExchangeOptions, initial: SessionSubmissionObservation): Promise<SessionSubmissionObservation> {
    const key = 'channel-exchange:' + options.id;
    let turn = await options.journal.get<Turn>(key) ?? {phase: 'idle', consumed: []};
    if (turn.history?.length) await options.report?.('resumed', turn.history.at(-1)!.id);
    let requests = (await options.readRequests()).map(row => row.request);
    for (const request of requests) await freezeRequest(options, request);
    if (turn.phase !== 'idle') {
        const settled = await settleTurn(options, key, turn);
        if ('outcome' in settled) return settled;
        turn = settled;
        requests = (await options.readRequests()).map(row => row.request);
        for (const request of requests) await freezeRequest(options, request);
    } else if (initial.outcome !== 'succeeded') return initial;
    const pending = requests.filter(request => !turn.consumed.includes(request.id));
    if (!pending.length) return {...initial, outcome: 'succeeded', code: undefined};
    if (typeof options.finalPublished === 'function' ? await options.finalPublished() : options.finalPublished) throw failure('CHANNEL_RESULT_CONFLICT');
    if (pending.length > 16 || turn.consumed.length + pending.length > 128) throw failure('CHANNEL_LIMIT');
    return prepareTurn(options, key, turn, pending);
}
async function settleTurn(options: ChannelExchangeOptions, key: string, turn: Turn): Promise<Turn | SessionSubmissionObservation> {
    for (const id of turn.requests!) {
        const receipt = await options.journal.get<Receipt>('channel-exchange-request:' + options.id + ':' + id);
        const published = (await options.readRequests()).find(row => row.request.id === id)?.response;
        if (!receipt?.response || !published || channelDigest(published) !== channelDigest(receipt.response)) throw failure('CHANNEL_RESPONSE_CHANGED');
    }
    await options.report?.('waiting-context', turn.requests![0]);
    const result = await observeTurn(options, key, turn);
    if (result.outcome !== 'succeeded') return result;
    const completedId = turn.request!.submission!.id;
    const next = await options.journal.update<Turn>(key, old => ({phase: 'idle', consumed: [...new Set([...old!.consumed, ...old!.requests!])], history: [...old?.history ?? [], {id: completedId, requests: old!.requests!}]}));
    await options.report?.('resumed', completedId); return next;
}
async function prepareTurn(options: ChannelExchangeOptions, key: string, turn: Turn, pending: ChannelRequest[]): Promise<SessionSubmissionObservation> {
    const replies: ChannelReply[] = [];
    for (const request of pending) replies.push(await publishResponse(options, request));
    const request = await options.prepare(randomUUID(), replies);
    await options.journal.update<Turn>(key, old => {
        if (old && old.phase !== 'idle') throw failure('CHANNEL_BUSY');
        return {phase: 'prepared', history: turn.history, consumed: turn.consumed, requests: pending.map(row => row.id), request};
    });
    await options.report?.('waiting-context', pending[0].id);
    const observed = await observeTurn(options, key, {phase: 'prepared', consumed: turn.consumed, requests: pending.map(row => row.id), request});
    return observed.outcome === 'succeeded' ? {...observed, outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'} : observed;
}
async function freezeRequest(options: ChannelExchangeOptions, request: ChannelRequest): Promise<void> {
    const digest = channelDigest(request), saved = await options.journal.get<Receipt>('channel-exchange-request:' + options.id + ':' + request.id);
    if (saved) {if (saved.digest !== digest) throw failure('CHANNEL_REQUEST_CHANGED'); return;}
    await options.journal.update<Receipt>('channel-exchange-request:' + options.id + ':' + request.id, old => {
        if (old && old.digest !== digest) throw failure('CHANNEL_REQUEST_CHANGED');
        return old ?? {digest, request};
    });
}
async function publishResponse(options: ChannelExchangeOptions, request: ChannelRequest): Promise<ChannelReply> {
    const key = 'channel-exchange-request:' + options.id + ':' + request.id;
    let receipt = (await options.journal.get<Receipt>(key))!;
    if (!receipt.response) {
        let result: Pick<ChannelResponse, 'status' | 'payload' | 'error'>;
        try {result = {status: 'ok', payload: await options.resolve(request), error: null};}
        catch (error) {
            const value = error as {channelResponse?: boolean; code?: string};
            if (value?.channelResponse !== true) throw error;
            result = {status: 'error', payload: null, error: {code: /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code ?? '') ? value.code! : 'CHANNEL_RESOLUTION_FAILED'}};
        }
        const response: ChannelResponse = {id: request.id, scopeId: options.scopeId, requestDigest: receipt.digest, ...result};
        if (new TextEncoder().encode(JSON.stringify(response)).byteLength > 65536) {
            response.status = 'error'; response.payload = null; response.error = {code: 'CHANNEL_RESPONSE_LIMIT'};
        }
        receipt = await options.journal.update<Receipt>(key, old => old!.response ? old! : {...old!, response});
    }
    const published = await options.publishResponse(receipt.response!);
    if (channelDigest(published) !== channelDigest(receipt.response)) throw failure('CHANNEL_RESPONSE_CHANGED');
    await options.report?.('response', request.id, receipt.response?.error?.code);
    return {id: request.id, requestDigest: receipt.digest, sha256: channelDigest(receipt.response)};
}
async function observeTurn(options: ChannelExchangeOptions, key: string, turn: Turn): Promise<SessionSubmissionObservation> {
    try {
        if (turn.phase === 'prepared' && await options.journal.claim(key)) await options.submission.start(turn.request!);
        const result = await options.submission.inspect(turn.request!);
        return result.outcome === 'running' ? {...result, code: 'WORKSPACE_CONTEXT_PENDING'} : result;
    } catch (error) {
        const value = error as {executionOutcome?: string; retryable?: boolean; code?: string};
        if (value?.executionOutcome === 'not-started' && value.retryable === true)
            await options.journal.update<Turn>(key, old => ({...old!, phase: 'prepared'}));
        return {sessionId: turn.request!.expectedSessionId!, outcome: 'unknown', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.code ?? '') ? value.code : 'CHANNEL_RECEIPT_UNKNOWN'};
    }
}
