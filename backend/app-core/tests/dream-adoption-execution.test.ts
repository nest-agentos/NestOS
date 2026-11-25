import {expect, it} from 'vitest';
import type {KanbanDispatch, KanbanItem} from '@nestos/kanban/contracts';
import {adoptionExecution} from '../src/dream/adoption-execution';

it('links only an accepted dispatch belonging to the adopted item', () => {
    const item = {id: 'item', status: 'completed', resultRef: 'kanban:dispatch:dispatch',
        acceptanceResult: {dispatchId: 'dispatch', outcome: 'passed'}} as KanbanItem;
    const dispatch = {id: 'dispatch', itemId: 'item', outcome: 'accepted', executionSessionId: 'session', outputs: []} as unknown as KanbanDispatch;
    expect(adoptionExecution(item, {dispatch})).toEqual({dispatchId: 'dispatch', sessionId: 'session', outputs: []});
    expect(adoptionExecution({...item, status: 'backlog'}, {dispatch})).toBeUndefined();
    expect(adoptionExecution({...item, resultRef: 'chat:session'}, {dispatch})).toBeUndefined();
    expect(adoptionExecution(item, {dispatch: {...dispatch, outcome: 'failed'}})).toBeUndefined();
    expect(adoptionExecution(item, {dispatch: {...dispatch, itemId: 'other'}})).toBeUndefined();
    expect(adoptionExecution(item, {dispatch: {...dispatch, executionSessionId: undefined}})).toBeUndefined();
    expect(adoptionExecution({...item, acceptanceResult: {...item.acceptanceResult!, outcome: 'waived'}}, {dispatch})).toBeUndefined();
});
