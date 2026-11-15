import {channelDigest,type ChannelRequest} from './channel-protocol';
import {failure} from './prompt-bundle';
export interface ChannelRequestMethod {id:string;kind:'query'|'command';description:string;inputSchema:Record<string,unknown>;run(request:ChannelRequest):Promise<unknown>}
export interface ChannelRequestPlugin {id:string;version:string;description:string;methods:ChannelRequestMethod[]}
/** A fixed discovery protocol keeps plugin schemas out of the permanent MCP tool catalog. */
export async function resolveChannelPlugin(request:ChannelRequest,plugins:readonly ChannelRequestPlugin[]):Promise<unknown> {
    if(plugins.length>32)throw failure('CHANNEL_PLUGIN_LIMIT');
    const ids=new Set<string>();
    for(const plugin of plugins){if(!/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id)||ids.has(plugin.id)||plugin.description.length>240||plugin.methods.length>64||new Set(plugin.methods.map(row=>row.id)).size!==plugin.methods.length)throw failure('CHANNEL_PLUGIN_INVALID');ids.add(plugin.id);}
    if(request.method==='kanban.discover')return {protocol:1,plugins:plugins.map(({id,version,description})=>({id,version,description}))};
    const plugin=plugins.find(row=>row.id===request.params.pluginId);if(!plugin)throw failure('CHANNEL_PLUGIN_UNAVAILABLE');
    if(request.method==='kanban.describe'&&request.params.method===undefined)return {pluginId:plugin.id,version:plugin.version,methods:plugin.methods.map(({id,kind,description})=>({id,kind,description}))};
    const method=plugin.methods.find(row=>row.id===request.params.method);if(!method)throw failure('CHANNEL_PLUGIN_METHOD_UNAVAILABLE');
    if(request.method==='kanban.describe')return {pluginId:plugin.id,version:plugin.version,id:method.id,kind:method.kind,description:method.description,inputSchema:method.inputSchema};
    if(request.method!=='kanban.invoke')throw failure('CHANNEL_PLUGIN_REQUEST_UNSUPPORTED');
    const input=request.params.input;
    if(!input||typeof input!=='object'||Array.isArray(input))throw failure('CHANNEL_PLUGIN_INPUT_INVALID');
    // Canonicalization rejects unsupported values before a plugin may perform effects.
    channelDigest(input);return method.run({...request,method:method.id,params:input as Record<string,unknown>});
}
