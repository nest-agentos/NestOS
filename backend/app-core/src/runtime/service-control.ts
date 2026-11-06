/** Trusted host capability. Models and project files can reference a target, never mint this authority. */
export interface ServiceSwitchRequest {operationId:string;serviceId:string;expectedVersion:string;targetVersion:string}
export interface RuntimeServiceDescriptor {id:string;version:string;artifact?:{format:string;manifest:string;store?:{base:'source-checkout';path:string}}}
export interface RuntimeServiceControl {
    describe():Promise<RuntimeServiceDescriptor>;
    submit(request:ServiceSwitchRequest):Promise<void>;
    inspect(request:ServiceSwitchRequest):Promise<{state:'running'|'succeeded'|'failed';version?:string;code?:string}>;
}
