import {escapeHTML,t} from '@nestos/common';
import type {CellsAuthorizationRefresh} from '@nestos/app-contracts/services';
const e=escapeHTML;
export function authorizationNotice(value:CellsAuthorizationRefresh|undefined,outdatedProjectCount=0):string {
    if(!value)return outdatedProjectCount>0?`<div class="cells-node__authorization" role="status">
        <p>${e(t('cells.authorization.outdatedProjects',{count:outdatedProjectCount}))}</p>
        <button type="button" class="settings-btn" data-cells-action="refresh-bindings">${e(t('cells.authorization.refreshBindings'))}</button></div>`:'';
    if(value.state==='available')return `<div class="cells-node__authorization" role="status">
        <strong>${e(t('cells.authorization.changed'))}</strong><p>${e(t('cells.authorization.confirmHint'))}</p>
        <dl><dt>${e(t('cells.authorization.server'))}</dt><dd>${e(value.serverId)}</dd>
        <dt>${e(t('cells.authorization.principal'))}</dt><dd>${e(value.principalId)}</dd>
        <dt>${e(t('cells.authorization.previous'))}</dt><dd><code>${e(value.previousRevision)}</code></dd>
        <dt>${e(t('cells.authorization.next'))}</dt><dd><code>${e(value.nextRevision)}</code></dd></dl>
        <p>${e(t('cells.authorization.projects',{count:value.affectedProjectIds.length}))}</p>
        <button type="button" class="settings-btn" data-cells-action="authorization">${e(t('cells.authorization.confirm'))}</button></div>`;
    const title=value.state==='unchanged'?t('cells.authorization.unchangedTitle'):t('cells.authorization.changed');
    const text=value.state==='blocked'?t(`cells.authorization.${value.reason}`):value.state==='unchanged'
        ?t('cells.authorization.unchanged'):t('cells.authorization.unavailable',{code:value.code});
    return `<div class="cells-node__authorization" role="status"><strong>${e(title)}</strong><p>${e(text)}</p>
        <button type="button" class="settings-btn settings-btn--secondary" data-cells-action="refresh">${e(t('cells.authorization.retry'))}</button>
        <button type="button" class="settings-btn settings-btn--secondary" data-cells-action="configure">${e(t('cells.connection'))}</button></div>`;
}
export function authorizationError(error:unknown):string|undefined {
    const message=error instanceof Error?error.message:'';
    for(const key of ['EXPIRED','CHANGED','IDENTITY_CHANGED'] as const) {
        if(message.includes('CELLS_AUTHORIZATION_'+(key==='IDENTITY_CHANGED'?key:'REFRESH_'+key)))return t(`cells.authorization.error.${key}`);
    }
}
export function safeErrorCode(error:unknown,fallback:string):string {
    const candidate=(error as {remoteCode?:unknown;code?:unknown})?.remoteCode??(error as {code?:unknown})?.code;
    return typeof candidate==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)?candidate:fallback;
}
export function bindingRefreshError(error:unknown):string {
    const code=safeErrorCode(error,'BINDING_REFRESH_FAILED');
    if(code==='ENOENT')return t('diagnostics.bindingConnectionMissing');
    if(['EACCES','FORBIDDEN','UNAUTHENTICATED'].includes(code))return t('diagnostics.bindingAccessDenied');
    return error instanceof Error&&error.message?error.message:t('diagnostics.bindingRefreshFailed');
}
