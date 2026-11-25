import {authorizeEvidence, type DreamSource, type SourcePort} from '@nestos/dream';
import type {DreamEvidenceStore} from './evidence-store';
import type {DreamConfigStore} from './config-store';

/** Recheck every recorded source rather than inheriting access from the Dream owner. */
export async function readAuthorizedDreamRun(store: DreamEvidenceStore, projectId: string, dreamId: string, operationId: string,
    selected: readonly DreamSource[], port: Pick<SourcePort<unknown>, 'authorize'>) {
    const run = await store.run(projectId, dreamId, operationId);
    if (!run) return null;
    const evidence = run.outcomes.filter(item => item.status === 'ok').map(item => item.evidence);
    const authorized = await authorizeEvidence(evidence, selected, source => port.authorize(source));
    const initiallyAllowed = new Set(authorized.flatMap(item => item.status === 'available' ? [item.evidence.sourceId] : []));
    const findings = [];
    for (const id of run.findings ?? []) {
        const finding = await store.finding(projectId, dreamId, id);
        if (!finding) throw new Error('DREAM_FINDING_MISSING');
        if (initiallyAllowed.has(finding.sourceId)) findings.push(finding);
    }
    const final = await authorizeEvidence(evidence, selected, source => port.authorize(source));
    const checked = final.map((item, index) => authorized[index].status === 'available' ? item : authorized[index]);
    const allowed = new Set(checked.flatMap(item => item.status === 'available' ? [item.evidence.sourceId] : []));
    let index = 0;
    const sources = run.outcomes.map(item => item.status === 'ok' ? checked[index++] : item);
    return {operationId: run.operationId, sources, findings: findings.filter(finding => allowed.has(finding.sourceId)),
        ...(run.execution && allowed.size ? {execution: run.execution} : {})};
}

/** The host supplies the session's authorized projects; inactive findings never enter context. */
export async function retrieveDreamFacts(store: DreamEvidenceStore, configs: DreamConfigStore, projectId: string, dreamId: string, operationId: string,
    scope: {projectIds: readonly string[]; sourceIds: readonly string[]}, port: Pick<SourcePort<unknown>, 'authorize'>, authorizeOwner: () => Promise<void>) {
    try {await authorizeOwner();} catch {throw new Error('DREAM_OWNER_AUTHORIZATION_FAILED');}
    const config = await configs.read(projectId, dreamId);
    if (!config?.config.enabled) return [];
    const allowed = new Set(scope.projectIds), sources = new Set(scope.sourceIds);
    const selected = config.config.files.filter(file => allowed.has(file.projectId) && sources.has(file.id)).map(file => ({id: file.id,
        projectId: file.projectId, connectionId: file.connectionId, cursor: null}));
    const view = await readAuthorizedDreamRun(store, projectId, dreamId, operationId, selected, port);
    await store.checkConfig(projectId, dreamId, config.revision);
    try {await authorizeOwner();} catch {throw new Error('DREAM_OWNER_AUTHORIZATION_FAILED');}
    return (view?.findings ?? []).filter(finding => finding.state === 'active' && finding.kind !== 'suggestion');
}
