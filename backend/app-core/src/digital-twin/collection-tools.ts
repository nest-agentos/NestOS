import type {TwinCollectionExecutor, TwinScannerTool} from '@nestos/app-contracts';
import {sha256HexSync} from '@nestos/llm-context';
import type {IToolService} from '@nestos/tools/contracts';
import type {ToolPackageInfo} from '@nestos/app-contracts/services';
export type CollectionToolCatalog = Pick<IToolService, 'listTools' | 'getToolDefinitions' | 'getToolDefaults'>;
/** Catalog metadata is safe to project; executable handlers and credentials remain in the Session scope. */
export function collectionTools(catalog: CollectionToolCatalog): TwinScannerTool[] {
    const definitions = catalog.getToolDefinitions();
    return catalog.listTools().filter(meta => meta.enabled && meta.version && meta.sideEffect !== 'external').flatMap(meta => {
        const definition = definitions.find(item => (item.function?.name ?? item.name) === meta.id);
        if (!definition) return [];
        const parameters = definition.function?.parameters ?? definition.parameters ?? {type: 'object', properties: {}};
        const defaults = catalog.getToolDefaults?.(meta.id);
        return [{...(defaults && Object.keys(defaults).length ? {defaults: defaults as TwinScannerTool['defaults']} : {}), name: meta.name || meta.id, description: meta.description, source: meta.type,
            target: {kind: 'tool' as const, id: meta.id, version: meta.version!, digest: sha256HexSync(JSON.stringify([meta, definition]))},
            parameters: structuredClone(parameters) as TwinScannerTool['parameters']}];
    });
}
export function validateCollectionTool(catalog: CollectionToolCatalog, executor: TwinCollectionExecutor): void {
    if (executor.target.kind !== 'tool') return;
    const expected = executor.target;
    if (!collectionTools(catalog).some(item => item.target.id === expected.id && item.target.version === expected.version && item.target.digest === expected.digest))
        throw new Error('TWIN_SCANNER_TARGET_CHANGED');
}

/** Explain a rejected frozen target: which identity component moved and what the catalog offers now. */
export type CollectionTargetMatch = 'exact' | 'version' | 'digest' | 'missing' | 'unavailable';
export interface CollectionTargetDiagnostics {
    targetKind: string; targetId: string; targetVersion: string; targetDigest: string;
    catalogMatch: CollectionTargetMatch; catalogSize: number; catalogVersion?: string; catalogDigest?: string;
}
export function describeCollectionTarget(catalog: CollectionToolCatalog | undefined, executor: TwinCollectionExecutor): CollectionTargetDiagnostics {
    const target = executor.target;
    const base = {targetKind: target.kind, targetId: target.id, targetVersion: target.version, targetDigest: digestPrefix(target.digest)};
    if (!catalog) return {...base, catalogMatch: 'unavailable', catalogSize: 0};
    const tools = collectionTools(catalog), match = tools.find(item => item.target.id === target.id);
    if (!match) return {...base, catalogMatch: 'missing', catalogSize: tools.length};
    const catalogMatch: CollectionTargetMatch = match.target.version !== target.version ? 'version' : match.target.digest !== target.digest ? 'digest' : 'exact';
    return {...base, catalogMatch, catalogSize: tools.length, catalogVersion: match.target.version, catalogDigest: digestPrefix(match.target.digest)};
}
function digestPrefix(digest: string): string {return digest.slice(0, 16);}

/** Presentation changes neither execution identity nor admission of existing compatibility tools. */
export function presentCollectionTools(tools: TwinScannerTool[], packages: ToolPackageInfo[]): TwinScannerTool[] {
    const declarations = packages.filter(item => item.status === 'registered').flatMap(item => item.configuration?.tools ?? []);
    return tools.map(tool => {
        const display = declarations.find(item => item.id === tool.target.id);
        if (!display) return tool;
        const {parameters, advanced, optionLabels} = display;
        return {...tool, hidden: display.hidden, name: display.label ?? tool.name, presentation: {parameters, advanced, optionLabels}};
    });
}
