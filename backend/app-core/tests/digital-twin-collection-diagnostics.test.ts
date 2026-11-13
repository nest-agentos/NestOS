import {afterEach, expect, it, vi} from 'vitest';
import {collectionTools, describeCollectionTarget, type CollectionToolCatalog} from '../src/digital-twin/collection-tools';
import {PublishedScannerCollector} from '../src/digital-twin/scanner-collector';
import type {ToolMeta} from '@nestos/tools/contracts';

afterEach(() => {vi.restoreAllMocks();});

const meta: ToolMeta = {id: 'google.collect', name: 'Mail and calendar collection', description: 'Collect Gmail and Calendar', sideEffect: 'local',
    timeoutMs: 120000, type: 'plugin', enabled: true, version: '1'};
const definition = {type: 'function' as const, function: {name: 'google.collect', description: 'Collect', parameters: {type: 'object', properties: {}}}};
function catalog(overrides: Partial<ToolMeta> = {}): CollectionToolCatalog {
    const current = {...meta, ...overrides};
    return {listTools: () => [current], getToolDefinitions: () => [definition as never], getToolDefaults: () => ({})};
}
const currentDigest = () => collectionTools(catalog())[0].target.digest;
const frozen = (digest: string, version = '1') => ({target: {kind: 'tool' as const, id: 'google.collect', version, digest}});

it('keeps the frozen target digest stable across host runtime metadata and moves it when the schema changes', () => {
    const base = currentDigest();
    expect(collectionTools(catalog({executionIsolation: 'process'}))[0].target.digest).toBe(base);
    expect(collectionTools(catalog({timeoutMs: 99_000, tags: ['other'], icon: 'x'}))[0].target.digest).toBe(base);
    const moved = {type: 'function' as const, function: {name: 'google.collect', description: 'Collect', parameters: {type: 'object', properties: {calendarId: {type: 'string'}}}}};
    expect(collectionTools({...catalog(), getToolDefinitions: () => [moved as never]})[0].target.digest).not.toBe(base);
});

it('reports which identity component diverged from the current tool catalog', () => {
    expect(describeCollectionTarget(catalog(), frozen(currentDigest()))).toMatchObject({catalogMatch: 'exact', catalogSize: 1, catalogVersion: '1'});
    expect(describeCollectionTarget(catalog(), frozen('other-digest'))).toMatchObject({catalogMatch: 'digest', targetId: 'google.collect', targetVersion: '1'});
    expect(describeCollectionTarget(catalog(), frozen('other-digest', '2'))).toMatchObject({catalogMatch: 'version', catalogVersion: '1'});
    expect(describeCollectionTarget(catalog(), {target: {kind: 'tool', id: 'google.calendar.collect', version: '1', digest: 'other'}}))
        .toMatchObject({catalogMatch: 'missing', catalogSize: 1, targetId: 'google.calendar.collect'});
    expect(describeCollectionTarget(undefined, frozen('other-digest'))).toMatchObject({catalogMatch: 'unavailable', catalogSize: 0});
    expect(describeCollectionTarget(catalog({enabled: false}), frozen(currentDigest()))).toMatchObject({catalogMatch: 'missing'});
});

it('logs the frozen target, the catalog match and the failure phase when a switch target was republished', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const collector = new PublishedScannerCollector({tools: {tools: catalog()},
        kernel: {listSessionTasks: async () => []} as never, repository: {} as never, ready: () => ({calls: {} as never})});
    const executor = {target: {kind: 'tool' as const, id: 'google.collect', version: '1', digest: 'stale-digest'}, values: {resource: 'calendar'}};
    await expect(collector.collect({runId: 'run-fixture', sessionId: 'twin-collection-run-fixture', executor}, async () => {}, async () => {}))
        .rejects.toThrow('TWIN_SCANNER_TARGET_CHANGED');
    const warn = vi.mocked(console.warn).mock.calls.map(call => call[1] as Record<string, unknown>).find(event => event.stage === 'failed')!;
    expect(warn).toMatchObject({sessionId: 'twin-collection-run-fixture', operationId: 'run-fixture', category: 'collection-execution',
        phase: 'target-validation', errorCode: 'TWIN_SCANNER_TARGET_CHANGED', targetKind: 'tool', targetId: 'google.collect',
        targetVersion: '1', targetDigest: 'stale-digest', catalogMatch: 'digest', catalogSize: 1});
    const prepare = vi.mocked(console.info).mock.calls.map(call => call[1] as Record<string, unknown>).find(event => event.stage === 'collection.prepare')!;
    expect(prepare).toMatchObject({targetId: 'google.collect', targetVersion: '1', targetDigest: 'stale-digest'});
});
