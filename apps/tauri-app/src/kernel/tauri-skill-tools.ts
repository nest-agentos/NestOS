import type { SkillDefinition, SkillToolBinding, ToolHandler } from '@itookit/tools/contracts';
import type { SkillToolHandlerFactory } from '@itookit/kernel-adapters';
import type { TauriNativeShell } from '../shell/tauri-native-shell';

export class TauriSkillToolHandlerFactory implements SkillToolHandlerFactory {
    constructor(private readonly shell: TauriNativeShell) {}

    create(skill: SkillDefinition, binding: SkillToolBinding): ToolHandler | undefined {
        if (binding.executionType === 'http' && skill.endpoint) return createHttpHandler(skill);
        if (binding.executionType === 'shell' && binding.command) return createShellHandler(this.shell, binding);
        return undefined;
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

function createShellHandler(shell: TauriNativeShell, binding: SkillToolBinding): ToolHandler {
    return async (args, context) => {
        const command = renderCommand(binding.command!, args);
        const result = await shell.exec('sh', ['-c', command], {
            cwd: context.cwd,
            timeoutMs: context.timeoutMs,
            signal: context.signal,
        });
        if (result.code !== 0) throw new Error(result.stderr || `Shell exited with ${result.code}`);
        return result.stdout;
    };
}

function renderCommand(template: string, args: Record<string, unknown>): string {
    let command = template;
    for (const [key, value] of Object.entries(args)) {
        command = command.split(`{{${key}}}`).join(shellQuote(String(value)));
    }
    if (/\{\{[^}]+\}\}/.test(command)) throw new Error('Missing shell Skill template argument');
    return command;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
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
