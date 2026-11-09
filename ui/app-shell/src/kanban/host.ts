import {ACTION_ICONS, CHAT_ICONS, PROJECT_ACTION_ICONS, t, createModuleLogger} from '@nestos/common';
import type {KanbanPresentation, KanbanUIOptions} from '@nestos/kanban-ui';
const log = createModuleLogger('kanban');
export const kanbanPresentation: KanbanPresentation = {
    resourceRole: (reference,references) => reference.system==='nestos-remote-project'&&references.some(ref=>ref.system==='nestos-primary-project')?t(references.some(ref=>ref.system==='nestos-primary-project'&&ref.id===reference.id)?'kanban.primaryProject':'kanban.secondaryProject'):undefined,
    resourceLabel: reference => reference.system==='nestos-primary-project'?`${t('kanban.primaryProject')}：${reference.id}`:reference.system==='nestos-remote-project'?reference.id:undefined,
    text: (key, values) => t(`kanban.${key}` as Parameters<typeof t>[0], values),
    icons: {refreshView: ACTION_ICONS.refreshView, more: CHAT_ICONS.more, close: ACTION_ICONS.close, back: ACTION_ICONS.back, copy: CHAT_ICONS.copy, link: ACTION_ICONS.link, archive: PROJECT_ACTION_ICONS.archive, delete: CHAT_ICONS.delete, run: ACTION_ICONS.run, pause: ACTION_ICONS.pause, resume: ACTION_ICONS.run, fix: ACTION_ICONS.fix, edit: ACTION_ICONS.edit},
    referenceUrl: path => `${location.href.split('#')[0]}#/kanban/${encodeURIComponent(path)}`,
    log: event => {if (event.result === 'failure') log.warn('kanban.ui', event); else log.debug('kanban.ui', event);},
};
/** Product deployment guidance is supplied to the portable view through a semantic port. */
export const kanbanReviewGuidance: NonNullable<KanbanUIOptions['reviewGuidance']> = (board, item) => {
    if (!item.externalRefs?.some(ref => ref.system === 'nestos-worktree') && board.automation?.preparation?.id !== 'git-worktree') return;
    return {title: t('kanban.developmentReview.title'), paragraphs: [
        t('kanban.developmentReview.pending'), t('kanban.developmentReview.switch'), t('kanban.developmentReview.verify'),
        t('kanban.developmentReview.accept'), t('kanban.developmentReview.mergeAnalysis'), t('kanban.developmentReview.mergeConfirm'),
        t('kanban.developmentReview.reject'), t('kanban.developmentReview.cleanup'),
    ]};
};
