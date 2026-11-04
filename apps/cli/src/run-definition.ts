import type { RunAgentConfig, RunConnectionConfig, RunDefinition, RunProviderConfig, RunSandboxConfig } from '@itookit/app-core';
import { compileDag } from './runtime';
import { memoryPolicyForAgent } from './memory-policy';
import type { CompiledWorkflow } from './types';

/** Compile the CLI YAML schema into the shared RunDefinition model. */
export function compileRunDefinition(workflow: CompiledWorkflow, digest: string, sessionWorkspace?: string): RunDefinition {
    const graph = compileDag(workflow, sessionWorkspace);
    return {
        id: workflow.config.name,
        name: workflow.config.name,
        revision: 1,
        digest,
        source: 'yaml',
        graph: { nodes: graph.nodes, edges: graph.edges },
        parameters: [],
        environment: {
            providers: workflow.config.providers.map((provider): RunProviderConfig => ({
                id: provider.id,
                name: provider.name,
                implementation: provider.implementation,
                baseUrl: provider.base_url,
                defaultPath: provider.default_path,
                responsesPath: provider.responses_path,
                apiKeyEnv: provider.api_key_env,
                models: provider.models.map(model => ({
                    id: model.id,
                    name: model.name,
                    contextWindow: model.context_window,
                    maxOutput: model.max_output,
                    supportsTools: model.supports_tools,
                    supportsThinking: model.supports_thinking,
                })),
            })),
            connections: workflow.config.connections.map((connection): RunConnectionConfig => ({
                id: connection.id,
                name: connection.name,
                provider: connection.provider,
                protocol: connection.protocol,
                tiers: connection.tiers,
            })),
            agents: workflow.config.agents.map((agent): RunAgentConfig => ({
                id: agent.id,
                name: agent.name,
                connection: agent.connection,
                modelTier: agent.model_tier,
                model: agent.model,
                systemPrompt: agent.system_prompt,
                memoryPolicy: memoryPolicyForAgent(agent),
                tools: agent.tools,
                maxExchanges: agent.max_exchanges,
                temperature: agent.temperature,
                maxTokens: agent.max_tokens,
                thinking: agent.thinking,
                reasoningEffort: agent.reasoning_effort,
                stream: agent.stream,
                webSearch: agent.web_search,
                approval: agent.approval,
            })),
            sandbox: workflow.config.sandbox as RunSandboxConfig | undefined,
        },
        policy: {
            result: workflow.config.result,
            workspaceRoot: workflow.workspaceRoot,
            runPolicy: {
                ...(workflow.config.runtime?.max_concurrency !== undefined ? { maxConcurrency: workflow.config.runtime.max_concurrency } : {}),
                ...(workflow.maxDurationMs !== undefined ? { timeoutMs: workflow.maxDurationMs } : {}),
                ...(workflow.config.runtime?.workspace ? { workspace: workflow.config.runtime.workspace } : {}),
            },
        },
        metadata: {
            goal: workflow.config.goal,
            workspaceRoot: workflow.workspaceRoot,
            stateDir: workflow.stateDir,
        },
        createdAt: Date.now(),
    };
}
