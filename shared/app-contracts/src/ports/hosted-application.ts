import type { ApplicationClient } from './application-client';
import type { FlowDraft } from '@nestos/llm-flow/contracts';

export interface HostedApplicationClient extends ApplicationClient {
    initialRead?: import('./startup-read').StartupReadResult;
    initialView?: import('./open-view').OpenedApplicationView;
    flowLibrary: FlowDraft[];
    fileTemplates: Readonly<Record<string, string>>;
}
