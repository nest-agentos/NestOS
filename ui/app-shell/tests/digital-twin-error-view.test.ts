import {expect, it} from 'vitest';
import {setLocale} from '@nestos/common';
import {twinError} from '../src/digital-twin/error-view';

it('distinguishes a republished scan target from a frozen-parameter mismatch', async () => {
    try {
        await setLocale('zh-CN');
        expect(twinError('TWIN_SCANNER_TARGET_CHANGED')).toBe('扫描目标的发布版本已变更，请在扫描目标中重新选择并保存');
        expect(twinError('TWIN_COLLECTION_TARGET_INVALID')).toBe('扫描目标与已冻结的参数不一致，请重新选择目标并保存');
        expect(twinError('TWIN_SCANNER_TARGET_CHANGED')).not.toBe(twinError('TWIN_COLLECTION_TARGET_INVALID'));
        expect(twinError('TWIN_COLLECTION_FAILED', 'RESOURCE_WRITE_DENIED')).toMatch(/RESOURCE_WRITE_DENIED$/);
        await setLocale('en');
        expect(twinError('TWIN_SCANNER_TARGET_CHANGED')).toMatch(/republished/);
        expect(twinError('TWIN_COLLECTION_TARGET_INVALID')).toMatch(/frozen parameters/);
        expect(twinError('')).toBe('');
    } finally { await setLocale('zh-CN'); }
});
