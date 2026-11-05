/** Trusted host capability. Models and project files can reference a target, never mint this authority. */
export interface ServiceSwitchRequest {operationId:string;serviceId:string;expectedVersion:string;targetVersion:string}
export interface RuntimeServiceControl {
    describe():Promise<{id:string;version:string}>;
    submit(request:ServiceSwitchRequest):Promise<void>;
    inspect(request:ServiceSwitchRequest):Promise<{state:'running'|'succeeded'|'failed';version?:string;code?:string}>;
}
