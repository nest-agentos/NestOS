import {t} from '@nestos/common';
import type {RemoteProjectStatus} from '@nestos/app-contracts/services';

export function projectStatusLabel(state: Pick<RemoteProjectStatus, 'status' | 'problem'>): string {
    return state.problem ? t(`diagnostics.problem.${state.problem}`) : t(`remote.state.${state.status}`);
}
