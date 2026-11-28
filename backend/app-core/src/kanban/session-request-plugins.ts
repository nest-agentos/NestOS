import {decisionCreationMethods} from './decision-creation-methods';
import {previewExecutionCheckWaiver,confirmExecutionCheckWaiver} from './execution-check-waiver';
import {beginManagementCleanup,readManagementCleanup,completeManagementCleanup} from './cleanup-review-conversations';
import {createModuleLogger} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
const log=createModuleLogger('kanban-session-plugins');
import type {ChannelRequestMethod,ChannelRequestPlugin} from '../run/channel-request-plugins';
import {channelPlugin,resolveChannelPlugin} from '../run/channel-request-plugins';
import {channelDigest} from '../run/channel-protocol';
import type {ChannelRequest} from '../run/channel-protocol';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {resolveDecisionRequest} from './decision-conversation-requests';
import {resolveCoordinationRequest} from './coordination-conversation-requests';
import {listDecisions,queryDecisions} from './decision-query';
import {requireValue} from './validation';
const string={type:'string'};
function schema(properties:Record<string,unknown>,required:string[]=[]):Record<string,unknown>{return {type:'object',properties,required,additionalProperties:false};}
/** Native MCP tools stay fixed; trusted host plugins advertise only schemas requested by the model. */
export async function resolveKanbanPluginRequest(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest) {
    const context=await options.journal.get<{recordId:string}>('decision-conversation-record:'+conversation.id);
    const management=conversation.binding.purpose==='coordination'?conversation:context?{...conversation,binding:{...conversation.binding,purpose:'coordination' as const,recordId:context.recordId}}:undefined;
    const method=(id:string,description:string,inputSchema:Record<string,unknown>,run:ChannelRequestMethod['run'],kind:'query'|'command'='query'):ChannelRequestMethod=>({id,kind,description,inputSchema,run});
    const decision=(id:string)=>(input:ChannelRequest)=>resolveDecisionRequest(options,conversation,{...input,method:'decision.'+id});
    const plugins:ChannelRequestPlugin[]=[{id:'decisions',version:'1',description:'Query decisions; scoped draft previews and dependency-aware confirmation.',methods:[
        method('list','List authorized decisions in creation order with a revision-bound cursor.',schema({boardId:string,limit:{type:'integer',minimum:1,maximum:50},cursor:string}),input=>listDecisions(options,conversation,input.params)),
        method('search','Find authorized related decisions and formal completion.',schema({query:string,boardId:string,limit:{type:'integer',minimum:1,maximum:50}}),input=>queryDecisions(options,conversation,input.params)),
        method('read','Read an existing decision without creating or starting it.',schema({boardId:string,recordId:string},['recordId']),async input=>{
            requireValue(typeof input.params.recordId==='string','DECISION_QUERY_INVALID');
            return options.service.record(typeof input.params.boardId==='string'?input.params.boardId:conversation.boardId,input.params.recordId);
        }),
        ...conversation.binding.purpose==='coordination'?[]:[
            method('status',decisionCreationMethods.status.description,decisionCreationMethods.status.inputSchema,decision('read')),
            method('propose',decisionCreationMethods.propose.description,decisionCreationMethods.propose.inputSchema,decision('propose'),'command'),
            method('confirm',decisionCreationMethods.confirm.description,decisionCreationMethods.confirm.inputSchema,decision('confirm'),'command'),
        ],
    ]}];
    if(management)plugins.push({id:'delivery',version:'1',description:'Bound management task delivery operations, analysis, integration and receipt reconciliation.',methods:[
        method('verification.preview','Preview named execution checks to waive; preserve failed evidence and original task identity.',schema({itemId:string,checks:{type:'array',items:string,maxItems:16},reason:string},['itemId','checks','reason']),input=>previewExecutionCheckWaiver(options,management,input),'command'),
        method('verification.waive','After exact user confirmation, record the waiver and notify the original executor; does not mark execution successful.',schema({previewId:string},['previewId']),input=>confirmExecutionCheckWaiver(options,management,input),'command'),
        method('cleanup.start','Ask the original management Session to review explicitly selected retained resources.',schema({itemId:string,scopeId:string,resourceIds:{type:'array',items:string,maxItems:16}},['itemId','scopeId','resourceIds']),input=>beginManagementCleanup(options,management,input.params,input.id),'command'),
        method('cleanup.read','Read the frozen cleanup review and host status.',schema({reviewId:string},['reviewId']),input=>readManagementCleanup(options,management,input.params.reviewId)),
        method('cleanup.complete','Finish a cleanup attempt; the host checks and removes actual resources before reporting success.',schema({reviewId:string},['reviewId']),input=>completeManagementCleanup(options,management,input.params.reviewId),'command'),
        method('read','Read plugin views, repository scopes, enabled actions and confirmations.',schema({itemId:string},['itemId']),input=>resolveCoordinationRequest(options,management,{...input,method:'coordination.operations.read'})),
        method('run','Invoke the enabled operation using its returned revision and real confirmation; retain request identity on uncertainty.',schema({itemId:string,request:schema({action:string,expectedRevision:string,pluginId:string,scopeId:string,selections:{type:'object',additionalProperties:string},followUp:string,reconcile:schema({runId:string},['runId'])},['action','expectedRevision'])},['itemId','request']),input=>resolveCoordinationRequest(options,management,{...input,method:'coordination.operations.run'}),'command'),
    ]});
    const available=[...plugins,...options.requestPlugins?.(conversation)??[]];
    if(request.method==='kanban.invoke'){const plugin=channelPlugin(request,available);
        const route={pluginId:plugin.id,version:plugin.version,method:request.params.method,digest:channelDigest(request)};
        await options.journal.update('session-plugin-route:'+conversation.id+':'+request.id,old=>{requireValue(!old||channelDigest(old)===channelDigest(route),'CHANNEL_PLUGIN_VERSION_CHANGED');return old??route;});}
    return resolveLogged(request,available,conversation.id);
}
async function resolveLogged(request:ChannelRequest,plugins:ChannelRequestPlugin[],scopeId:string) {
    const started=Date.now(),plugin=plugins.find(row=>row.id===request.params.pluginId);
    try{const value=await resolveChannelPlugin(request,plugins);log.info('Session plugin resolved',{operationId:request.id,scopeId,stage:'session.plugin.resolve',result:'success',pluginId:plugin?.id,method:plugin?.methods.find(row=>row.id===request.params.method)?.id,durationMs:Date.now()-started});return value;}
    catch(error){log.warn('Session plugin rejected',{operationId:request.id,scopeId,stage:'session.plugin.resolve',result:'failure',code:safeCode(error,'CHANNEL_PLUGIN_FAILED'),durationMs:Date.now()-started});throw error;}
}
