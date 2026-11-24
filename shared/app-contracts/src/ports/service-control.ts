/** Trusted host capability. Models and project files can reference a target, never mint this authority. */
export interface RuntimeServiceProject {serverId:string;serverProjectId:string;principalId:string;alias:string;root:string}
export interface ServiceSwitchRequest {operationId:string;serviceId:string;expectedVersion:string;targetVersion:string;project?:RuntimeServiceProject}
export interface RuntimeServiceDescriptor {id:string;version:string;project?:RuntimeServiceProject;build?:{command:string[];directory:string;base?:'source-checkout'};artifact?:{format:string;manifest:string;store?:{base:'source-checkout';path:string}}}
export interface RuntimeServiceControl {
    describeForProject?(serviceId:string,project:RuntimeServiceProject):Promise<RuntimeServiceDescriptor>;
    describe(serviceId?:string):Promise<RuntimeServiceDescriptor>;
    verifyArtifact?(request:{operationId:string;serviceId:string;version:string;sha256:string;sourceVersion?:string;project?:RuntimeServiceProject}):Promise<void>;
    runningArtifact?(request:{serviceId:string;sourceVersion:string;project:RuntimeServiceProject}):Promise<{version:string;sha256:string}|undefined>;
    provenance?(previousVersion:string,serviceId?:string):Promise<{serviceId:string;version:string;sourceCommit:string;dependencies?:Record<string,{current:string;previous:string}>}|undefined>;
    submit(request:ServiceSwitchRequest):Promise<void>;
    inspect(request:ServiceSwitchRequest):Promise<{state:'running'|'succeeded'|'failed';version?:string;code?:string}>;
}
