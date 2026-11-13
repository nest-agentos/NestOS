/** Trusted host capability. Models and project files can reference a target, never mint this authority. */
export interface ServiceSwitchRequest {operationId:string;serviceId:string;expectedVersion:string;targetVersion:string}
export interface RuntimeServiceDescriptor {id:string;version:string;artifact?:{format:string;manifest:string;store?:{base:'source-checkout';path:string}}}
export interface RuntimeServiceControl {
    describe():Promise<RuntimeServiceDescriptor>;
    verifyArtifact?(request:{operationId:string;serviceId:string;version:string;sha256:string}):Promise<void>;
    provenance?(previousVersion:string):Promise<{serviceId:string;version:string;sourceCommit:string;dependencies?:Record<string,{current:string;previous:string}>}|undefined>;
    submit(request:ServiceSwitchRequest):Promise<void>;
    inspect(request:ServiceSwitchRequest):Promise<{state:'running'|'succeeded'|'failed';version?:string;code?:string}>;
}
