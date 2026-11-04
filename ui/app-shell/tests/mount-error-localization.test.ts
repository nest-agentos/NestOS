import { describe, expect, it } from 'vitest';
import { t } from '@nestos/common';
import { DirectorySourceUnavailableError, SessionUnfinishedTasksError } from '@nestos/app-core';
import { localizeMountError } from '../src/files/localize-mount-error';

describe('mount error localization', () => {
    it('renders structured app-core errors as localized host copy', () => {
        expect((localizeMountError(new SessionUnfinishedTasksError('session-a')) as Error).message)
            .toBe(t('error.sessionUnfinishedTasks'));
        expect((localizeMountError(new DirectorySourceUnavailableError('home')) as Error).message)
            .toBe(t('error.directorySourceUnavailable'));
    });

    it('passes unrelated errors through unchanged', () => {
        const original = new Error('boom');
        expect(localizeMountError(original)).toBe(original);
    });
});
