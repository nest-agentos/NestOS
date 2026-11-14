import type {EditorOptions as HostEditorOptions} from '@nestos/ui-common-adapter';
import type {ConversationControls, RemoteAgentControls} from './ConversationControls';
import type {SessionDraftControls} from './SessionDraftControls';

/** NestOS conversation wiring extends the resource-neutral editor host contract. */
export interface ChatEditorOptions<TSubmission = unknown, TInitial = unknown> extends HostEditorOptions<TSubmission, TInitial> {
    /** Host projection of selectable executors for this editor's immutable context. */
    filterExecutors?(ids: string[]): Promise<string[]>;
    conversation?: ConversationControls;
    conversationInitial?: Pick<import('@nestos/app-contracts/services').PreparedConversation, 'draft' | 'models' | 'commands' | 'issues'>;
    remoteAgents?: RemoteAgentControls;
    /** A project draft remains separate from history until its first accepted submission. */
    sessionDraft?: SessionDraftControls<TSubmission>;
}
export type EditorOptions<TSubmission = unknown, TInitial = unknown> = ChatEditorOptions<TSubmission, TInitial>;

export type ChatEditorFactory = (container: HTMLElement, options: ChatEditorOptions) => Promise<import('@nestos/ui-common-adapter').IEditor>;
