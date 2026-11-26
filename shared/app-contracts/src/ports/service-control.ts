/** Trusted host capability. Models and project files can reference a target, never mint this authority. */
export interface RuntimeServiceProject {serverId:string;serverProjectId:string;principalId:string;alias:string;root:string}
export interface ServiceSwitchRequest {operationId:string;serviceId:string;expectedVersion:string;targetVersion:string;project?:RuntimeServiceProject}
export interface RuntimeServiceDescriptor {id:string;version:string;project?:RuntimeServiceProject;build?:{command:string[];directory:string;base?:'source-checkout'};artifact?:{format:string;manifest:string;store?:{base:'source-checkout';path:string}}}
export interface ServiceDiagnosticQuery {operationId?:string;requestId?:string;minutes?:number;limit?:number}
export type ServiceDiagnosticSource = 'httpd' | 'cells';
export interface ServiceDiagnosticAccess {
    revision: string;
    sources: ServiceDiagnosticSource[];
}
export interface UpdateServiceDiagnosticAccess {
    expectedRevision: string;
    sources: ServiceDiagnosticSource[];
    operationId: string;
}
export interface ProjectDiagnosticAccess {
    readDiagnosticAccess(projectId:string):Promise<ServiceDiagnosticAccess>;
    saveDiagnosticAccess(projectId:string,change:UpdateServiceDiagnosticAccess):Promise<ServiceDiagnosticAccess>;
}
export interface ServiceDiagnosticRecord {
    source:ServiceDiagnosticSource;
    time:string;
    operation?:string;
    stage?:string;
    result?:string;
    code?:string;
    durationMs?:number;
}
export interface ServiceDiagnosticResult {
    records:ServiceDiagnosticRecord[];
    sources:Record<ServiceDiagnosticSource,'read'|'unavailable'|'disabled'>;
}
export interface RuntimeServiceControl {
    describeForProject?(serviceId:string,project:RuntimeServiceProject):Promise<RuntimeServiceDescriptor>;
    readDiagnosticsForProject?(project:RuntimeServiceProject,projectId:string,query:ServiceDiagnosticQuery):Promise<ServiceDiagnosticResult>;
    diagnosticAccess?(project:RuntimeServiceProject):Promise<ServiceDiagnosticAccess>;
    saveDiagnosticAccess?(project:RuntimeServiceProject,change:UpdateServiceDiagnosticAccess):Promise<ServiceDiagnosticAccess>;
    describe(serviceId?:string):Promise<RuntimeServiceDescriptor>;
    verifyArtifact?(request:{operationId:string;serviceId:string;version:string;sha256:string;sourceVersion?:string;project?:RuntimeServiceProject}):Promise<void>;
    runningArtifact?(request:{serviceId:string;sourceVersion:string;project:RuntimeServiceProject}):Promise<{version:string;sha256:string}|undefined>;
    preparedArtifact?(request:{serviceId:string;sourceVersion:string;project:RuntimeServiceProject}):Promise<{version:string;sha256:string}|undefined>;
    provenance?(previousVersion:string,serviceId?:string):Promise<{serviceId:string;version:string;sourceCommit:string;dependencies?:Record<string,{current:string;previous:string}>}|undefined>;
    submit(request:ServiceSwitchRequest):Promise<void>;
    inspect(request:ServiceSwitchRequest):Promise<{state:'running'|'succeeded'|'failed';version?:string;code?:string}>;
}
