import type {ProjectRemoteMountPort,RuntimeServiceControl} from '@nestos/app-contracts/services';
import type {ChannelRequestPlugin} from '../run/channel-request-plugins';
import {resolveServiceProject} from '../presets/managed-service-deployment';
import {requireValue} from './validation';

const identity={type:'string',pattern:'^[A-Za-z0-9_.:-]{1,128}$'};

export function serviceDiagnosticsPlugins(control:RuntimeServiceControl|undefined,remote:Pick<ProjectRemoteMountPort,'list'|'projectRemountOptions'>,
    projectId:string):ChannelRequestPlugin[] {
    const read=control?.readDiagnosticsForProject;
    if(!read)return [];
    return [{id:'service-diagnostics',version:'1',description:'Read sanitized httpd and local Cells diagnostics for this authorized project.',methods:[{
        id:'read',kind:'query',description:'Find recent diagnostic metadata by exact operation or request identity.',
        inputSchema:{type:'object',additionalProperties:false,anyOf:[{required:['operationId']},{required:['requestId']}],
            properties:{operationId:identity,requestId:identity,minutes:{type:'integer',minimum:1,maximum:120},limit:{type:'integer',minimum:1,maximum:50}}},
        run:async request=>{
            requireValue(!Object.keys(request.params).some(key=>!['operationId','requestId','minutes','limit'].includes(key)),'SERVICE_DIAGNOSTICS_QUERY_INVALID');
            const project=await resolveServiceProject(remote,projectId);
            requireValue(project,'SERVICE_PROJECT_BINDING_REQUIRED');
            return read.call(control,project,projectId,request.params);
        },
    }]}];
}
