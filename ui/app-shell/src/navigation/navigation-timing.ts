import {NAVIGATION_EVENTS, createModuleLogger, randomUUID} from '@nestos/common';
import type {ClientDiagnostic} from '@nestos/app-contracts/services';

const log = createModuleLogger('navigation');
/** One operation owns the request trace and completes after the target UI is released. */
export function beginNavigationTiming(cached: boolean, report?: (diagnostic: ClientDiagnostic) => void | Promise<void>) {
    const operationId = randomUUID(), started = performance.now();
    const context = {operation:'navigation.open', operationId, cached};
    window.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.START, {detail:context}));
    log.info('navigation.open', {...context,stage:'start',result:'started',durationMs:0});
    return (result: 'success' | 'failure' | 'superseded') => {
        const record = {...context,stage:'ready',result,durationMs:Math.round(performance.now()-started)};
        window.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.END, {detail:record}));
        if (result === 'failure') log.warn('navigation.open',record); else log.info('navigation.open',record);
        if (result !== 'superseded' && (result === 'failure' || record.durationMs >= 1000)) {
            const diagnostic: ClientDiagnostic = {operation:'navigation.performance',operationId,stage:'ready',result:'failure',
                code:result === 'failure' ? 'NAVIGATION_FAILED' : 'NAVIGATION_SLOW', durationMs:Math.min(record.durationMs,86400000)};
            try {void Promise.resolve(report?.(diagnostic)).catch(()=>{});} catch { /* Diagnostics cannot block navigation or retry commands. */ }
        }
    };
}
