import {parseArgs} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {openCliApplication} from '../src/application-host';
import {createPerformanceMeasurement, assessPerformance} from '../../../scripts/performance-budget.mjs';

const {values} = parseArgs({options: {
    connect: {type: 'string'}, session: {type: 'string', multiple: true},
    'client-cert': {type: 'string'}, 'client-key': {type: 'string'}, 'ca-cert': {type: 'string'},
    samples: {type: 'string', default: '3'}, overview: {type: 'boolean', default: false},
    gate: {type: 'boolean', default: false}, dataset: {type: 'string'}, out: {type: 'string'}, baseline: {type: 'string'},
}});
type Measurement = ReturnType<ReturnType<typeof createPerformanceMeasurement>['stop']> & {scope: string; dataset: string};

/** This measures API readiness; browser render readiness must be validated separately. */
async function main(): Promise<void> {
    const samples = Number(values.samples), sessions = values.session ?? [];
    if (!values.connect || !sessions.length || !Number.isInteger(samples) || samples < 1 || samples > 20 ||
        (values.gate && (!values.dataset || !/^[a-zA-Z0-9_-]{1,80}$/.test(values.dataset))) || values.baseline && !values.gate)
        throw new Error('Expected --connect URL --session ID [--samples 1..20] [--gate --dataset ID --out FILE --baseline FILE]');
    const baseline = values.baseline ? JSON.parse(await readFile(values.baseline, 'utf8')) : undefined;
    const results: Array<Measurement & {assessment: ReturnType<typeof assessPerformance>}> = [];
    for (let sample = 1; sample <= samples; sample++) for (const sessionId of sessions) {
        const measured = await runSample(sessionId, sample);
        const previous = baseline?.results?.find((row: Measurement) => row.scope === measured.scope && row.dataset === measured.dataset);
        const assessment = assessPerformance(measured, previous);
        if (baseline && !previous) {assessment.passed = false; assessment.failures.push({code: 'BASELINE_NOT_COMPARABLE'});}
        results.push({...measured, assessment});
        console.log(JSON.stringify({sample, ...measured, assessment}));
    }
    const passed = results.length > 0 && results.every(row => row.assessment.passed);
    if (values.out) await writeFile(values.out, JSON.stringify({schema: 1, passed, results}, null, 2) + '\n', {mode: 0o600});
    if (values.gate && !passed) process.exitCode = 1;
}
async function runSample(sessionId: string, sample: number): Promise<Measurement> {
    const scope = 'session-api-ready:' + sessionId, meter = createPerformanceMeasurement();
    let application: Awaited<ReturnType<typeof openCliApplication>> | undefined, result: Measurement | undefined;
    try {
        application = await openCliApplication({connect: values.connect, clientCert: values['client-cert'],
            clientKey: values['client-key'], caCert: values['ca-cert']}, meter.request);
        const opened = await application.client.backend.openSessionView(sessionId);
        try {
            const background = values.overview ? application.client.backend.assistantOverview!() : undefined;
            void background?.catch(() => {});
            try {
                await opened.activate('main');
                result = meter.stop(true, {scope, dataset: values.dataset ?? 'unlabelled'}) as Measurement;
            } finally {if (background) await Promise.allSettled([background]);}
        } finally {await opened.dispose();}
    } catch (error) {
        result = {...meter.stop(false, {scope, dataset: values.dataset ?? 'unlabelled'}), completed: false} as Measurement;
        console.error(JSON.stringify({operation: 'session.profile', sample, result: 'failure', code: safeCode(error)}));
    } finally {
        try {await application?.close();} catch (error) {
            result = {...meter.stop(false, {scope, dataset: values.dataset ?? 'unlabelled'}), completed: false} as Measurement;
            console.error(JSON.stringify({operation: 'session.profile', stage: 'cleanup', result: 'failure', code: safeCode(error)}));
        }
    }
    return result!;
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'PROFILE_REQUEST_FAILED';
}
void main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Expected --connect') ? error.message : 'Session profile failed; check input files and HTTP diagnostics.');
    process.exitCode = 1;
});
