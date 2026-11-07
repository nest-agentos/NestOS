import {createModuleLogger, randomUUID, t} from '@nestos/common';
import type {ApplicationBackend} from '@nestos/app-contracts/services';

const log = createModuleLogger('study-prompts');
export async function loadStudyPrompts(backend: Pick<ApplicationBackend,'studyPromptPresets'>) {
    const operationId = randomUUID(), started = performance.now();
    try {
        const presets = await backend.studyPromptPresets();
        log.info('study.prompts', {operationId, stage:'read', result:'success', count:presets.length, durationMs:Math.round(performance.now()-started)});
        return {presets};
    } catch (error) {
        const raw = (error as {code?: unknown})?.code;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'STUDY_PROMPTS_UNAVAILABLE';
        log.warn('study.prompts', {operationId, stage:'read', result:'failure', code, durationMs:Math.round(performance.now()-started)});
        throw Object.assign(new Error(t('editor.studyPromptsUnavailable')), {code});
    }
}
