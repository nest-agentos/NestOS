// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {Toast} from '@nestos/ui-common-adapter';
import {revealLegacyMessage} from './legacy-message-location';

it('reports an unavailable message without logging its text', () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {}), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(revealLegacyMessage(null, 'message-id', 'PRIVATE_PROMPT_BODY')).toBeNull();
    expect(toast).toHaveBeenCalledOnce(); expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_PROMPT_BODY');
    toast.mockRestore(); warning.mockRestore();
});
