import { vi } from 'vitest';
const CELLS_EXTENSION = 'test/cells-descriptor';

/** Exercise the real SDK without a network listener or a second driver discovery. */
export function mockMCPDiscovery(descriptor: Record<string, unknown>) {
    return vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init) => {
        if (init?.method !== 'POST') return new Response(null,{status:405});
        const message = JSON.parse(String(init.body));
        const result = message.method === 'server/discover'
            ? {supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{[CELLS_EXTENSION]:descriptor}} : {tools:[]};
        return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{resultType:'complete',ttlMs:0,cacheScope:'private',...result}}),
            {headers:{'content-type':'application/json'}});
    });
}
