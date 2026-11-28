import {t} from '@nestos/common';
import type {ProjectService} from '@nestos/app-contracts/services';

type Settings = Awaited<ReturnType<NonNullable<ProjectService['remoteMounts']>['executionSettings']>>;
type Approvals = NonNullable<Settings['harnessApprovals']>['defaults'];
const labels = {
    ask: 'remote.harnessApprovalAsk',
    allowRead: 'remote.harnessApprovalRead',
    allowAll: 'remote.harnessApprovalAll',
    deny: 'remote.harnessApprovalDeny',
} as const;

export function projectApprovalSettings(parent: HTMLElement, defaults: Approvals | undefined) {
    if (!defaults) return () => undefined;
    const field = document.createElement('fieldset'), legend = document.createElement('legend');
    legend.textContent = t('remote.harnessApprovalDefaults'); field.append(legend);
    const kinds = (['codex', 'dsh', 'claude', 'agy'] as const).filter(kind => kind !== 'agy' || Object.hasOwn(defaults, kind));
    const names = {codex: 'Codex', dsh: 'DSH', claude: 'Claude', agy: 'AGY'};
    const controls = kinds.map(kind => {
        const label = document.createElement('label'), select = document.createElement('select');
        label.textContent = names[kind];
        for (const value of Object.keys(labels) as Array<keyof typeof labels>) {
            if (value === 'allowRead' && kind !== 'claude' && kind !== 'agy') continue;
            const option = document.createElement('option');
            option.value = value; option.textContent = t(labels[value]); select.append(option);
        }
        select.value = defaults[kind] ?? 'ask';
        label.append(select); field.append(label);
        return {kind, select};
    });
    parent.append(field);
    return (): Approvals => Object.fromEntries(controls.map(({kind, select}) => [kind, select.value]));
}
