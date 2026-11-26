import type {SessionDraftControls, SessionDraftMaterialization} from '@nestos/llm-ui-adapter/contracts';
import type { ConversationWorkbenchView, ProjectDraftComposer, SessionOpenView } from '@nestos/app-contracts/services';
import type {IEditor} from '@nestos/ui-common-adapter';
import type {SessionSubmission} from '@nestos/llm-flow/contracts';

/** Navigation adapts a headless draft use case into editor controls. */
export function createProjectDraftControls(composer: ProjectDraftComposer,
    navigation: { check(): Promise<void>; open(id: string, request?: SessionDraftMaterialization, submission?: SessionSubmission, view?: SessionOpenView): Promise<IEditor>;
        prepare?: ConversationWorkbenchView['prepareDraftSession'];
        begin?(): () => void;
        remote?(request: SessionDraftMaterialization): Promise<IEditor>; identity?(id: string): void },
    presentation: Pick<SessionDraftControls, 'scope' | 'executorScope' | 'promptHarness' | 'presentation'> = {}): SessionDraftControls<SessionSubmission> {
    let identity = composer.id, locked = composer.locked;
    return {
        ...presentation,
        get id() {return identity;},
        inPlace: !!navigation.remote, prepareWithDraft: composer.acceptsDraftOnPrepare, get locked() {return locked;},
        initialData: composer.initialData,
        attachments: composer.attachments,
        refresh: async () => {
            const next = await composer.refresh?.();
            if (next?.id) navigation.identity?.(next.id);
            return next ? createProjectDraftControls(next, {...navigation, prepare: undefined}, presentation) : undefined;
        },
        save: data => composer.save(data),
        clear: async () => {
            const next = await composer.clear(); locked = false; identity = typeof next === 'string' ? next : composer.id;
            if (identity) navigation.identity?.(identity);
        },
        materialize: async request => {
            await navigation.check();
            if (request?.agentId?.startsWith('remote:') && navigation.remote)
                return {editor: await navigation.remote(request), resumeOnly: false};
            const release = navigation.begin?.();
            try {
                const options = request && (request.title || request.harness || request.data !== undefined)
                    ? {title: request.title, harness: request.harness, ...(request.data !== undefined && {data: request.data})} : undefined;
                const prepared = request && identity && navigation.prepare
                    ? await navigation.prepare(identity, options) : {...await composer.prepare(options), view: undefined};
                request?.draftSaved?.();
                const editor = await navigation.open(prepared.sessionId, request, prepared.submission, prepared.view);
                return {editor, resumeOnly: prepared.resumeOnly, submission: prepared.submission};
            } finally {release?.();}
        },
    };
}
