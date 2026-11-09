import type {IncomingMessage, ServerResponse} from 'node:http';
import type {ApplicationRuntime} from '@nestos/app-core';
import type {AuditPort} from '../logging/audit-log';
import {ViewApi} from './view-api';
import {isSessionRecoveryRequest, SessionRecoveryApi} from './session-recovery-api';
/** Business operations borrow the user runtime directly; views only own presentation. */
export class RuntimeApi {
    private readonly views: ViewApi;
    private readonly recovery: SessionRecoveryApi;
    constructor(runtime: Promise<ApplicationRuntime>, audit?: AuditPort, ownsRuntime = true, configurationReadonly = false) {
        this.views = new ViewApi(runtime, audit, ownsRuntime, configurationReadonly);
        const service = runtime.then(value => value.sessionRecovery);
        void service.catch(() => {});
        this.recovery = new SessionRecoveryApi(service, audit);
    }
    handle(request: IncomingMessage, response: ServerResponse, authorize?: () => Promise<boolean>): Promise<void> {
        return isSessionRecoveryRequest(request) ? this.recovery.handle(request, response) : this.views.handle(request, response, authorize);
    }
    endStreams(): void {this.views.endStreams();}
    close(): Promise<void> {return this.views.close();}
}
