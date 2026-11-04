import type { SkillDefinition, SkillToolBinding, ToolHandler } from '@itookit/tools/contracts';
import type { SkillToolHandlerFactory } from '@itookit/kernel-adapters';

export class BrowserSkillToolHandlerFactory implements SkillToolHandlerFactory {
    create(skill: SkillDefinition, binding: SkillToolBinding): ToolHandler | undefined {
        if (binding.executionType !== 'http' || !skill.endpoint) return undefined;
        return createHttpHandler(skill);
    }
}

function createHttpHandler(skill: SkillDefinition): ToolHandler {
    const endpoint = validateEndpoint(skill.endpoint!);
    const method = skill.method ?? 'POST';
    return async (args, context) => {
        const url = method === 'GET' ? withQuery(endpoint, args) : endpoint;
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...(skill.headers ?? {}) },
            body: method === 'GET' ? undefined : JSON.stringify(args),
            signal: context.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}`);
        return response.text();
    };
}

function validateEndpoint(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`Unsupported Skill endpoint protocol: ${url.protocol}`);
    }
    return url.toString();
}

function withQuery(endpoint: string, args: Record<string, unknown>): string {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(args)) {
        url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return url.toString();
}
