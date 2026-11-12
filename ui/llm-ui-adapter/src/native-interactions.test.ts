import {expect, it} from 'vitest';
import {nativeInteraction, nativeResponse} from './native-interactions';
it('shows usable native approvals without asking the user to compose protocol JSON', () => {
    const view = nativeInteraction({id: 'approval', kind: 'approval', detail: 'python3 script.py', decisions: ['accept', 'cancel'], unsupportedDecisionCount: 1});
    expect(view.title).toBe('等待执行授权'); expect(view.kind).toBe('approval'); if (view.kind !== 'approval') return;
    expect(view.decisions).toEqual([{id: 'accept', label: '批准本次'}, {id: 'cancel', label: '取消当前执行'}]);
    expect(view.detail).toContain('部分授权选项暂不支持'); expect(view.detail).toContain('python3 script.py');
    expect(nativeResponse({kind: 'approval', decisionId: 'accept'})).toEqual({decision: 'accept'});
});
