import { FSError } from '@nestos/vfs-core';

/** Terminal transport state: existing capabilities must never be sent to a new view. */
export class ViewExpiredError extends FSError {
    constructor(readonly viewReason = 'VIEW_EXPIRED', readonly requestId?: string) {
        super('ECAPABILITY', 'View expired; reconnect the page');
    }
}
