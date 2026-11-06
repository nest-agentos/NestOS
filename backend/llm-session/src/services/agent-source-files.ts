import type {FSNode, IFileSystem} from '@nestos/vfs-core';
import {isModelDefaults} from '@nestos/kernel-adapters/contracts';
import type {AgentDefinition} from '../contracts';
import type {SessionLogger} from '../utils/host-ports';
import {ulid} from '../persistence/ulid';
import {agentSource} from './agent-flow-availability';

type AgentSource = AgentDefinition & {_scanPath: string};

/** A definition catalog is complete; interactive search pagination is not its boundary. */
export async function readAgentSources(fs: IFileSystem, logger: SessionLogger): Promise<AgentSource[]> {
    const sources: AgentSource[] = [], started = Date.now(), operationId = ulid(); let nodes: FSNode[];
    try {nodes = await sourceNodes(fs);}
    catch (error) {diagnose(logger, 'warn', {operationId, stage: 'catalog', result: 'failure', code: 'AGENT_CATALOG_READ_FAILED', durationMs: Date.now() - started}); throw error;}
    nodes.sort((a, b) => a.path.localeCompare(b.path));
    for (let offset = 0; offset < nodes.length; offset += 8) {
        const batch = await Promise.all(nodes.slice(offset, offset + 8).map(node => readAgentSource(fs, logger, node)));
        sources.push(...batch.filter((source): source is AgentSource => source !== null));
    }
    diagnose(logger, 'info', {operationId, stage: 'catalog', result: 'success',
        candidates: nodes.length, loaded: sources.length, skipped: nodes.length - sources.length, durationMs: Date.now() - started});
    return sources;
}

async function readAgentSource(fs: IFileSystem, logger: SessionLogger, node: FSNode): Promise<AgentSource | null> {
    const started = Date.now(), operationId = ulid(); let stage = 'read';
    try {
        const content = await fs.driver.readContent(node.path, {representation: 'bytes'});
        stage = 'decode';
        const data = agentSource(JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer)) as AgentDefinition);
        stage = 'validation';
        if (!data.id || data.modelDefaults !== undefined && !isModelDefaults(data.modelDefaults))
            throw Object.assign(new Error('Invalid Agent definition'), {code: 'AGENT_DEFINITION_INVALID'});
        return {...data, tags: [...node.tags], _scanPath: node.path};
    } catch (error) {
        const raw = (error as {code?: unknown})?.code;
        diagnose(logger, 'warn', {operationId, stage, result: 'failure',
            code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : stage === 'decode' ? 'AGENT_DEFINITION_INVALID' : 'AGENT_DEFINITION_READ_FAILED',
            durationMs: Date.now() - started});
        return null;
    }
}

async function sourceNodes(fs: IFileSystem): Promise<FSNode[]> {
    const nodes: FSNode[] = [];
    if (fs.driver.walkTree) {
        await fs.driver.walkTree(node => {if (node.type === 'file' && node.name.endsWith('.agent')) nodes.push(node);});
        return nodes;
    }
    for (let offset = 0; ; ) {
        const page = await fs.driver.search({name: {endsWith: '.agent'}, type: 'file', limit: 200, offset, orderBy: 'name'});
        nodes.push(...page.nodes);
        if (!page.hasMore) return nodes;
        if (!page.nodes.length) throw Object.assign(new Error('Incomplete Agent catalog page'), {code: 'AGENT_CATALOG_PAGE_INVALID'});
        offset += page.nodes.length;
    }
}

function diagnose(logger: SessionLogger, level: 'info' | 'warn', metadata: Record<string, unknown>): void {
    try {logger[level](level === 'info' ? 'Agent definition catalog loaded' : 'Agent definition skipped', {operation: 'agent.load', ...metadata});}
    catch { /* Diagnostics cannot hide persisted definitions. */ }
}
