import {expect,it,vi} from 'vitest';
import {projectServiceDiagnostics} from '../src/logging/project-service-diagnostics';

const now=Date.parse('2026-11-26T08:00:00.000Z');
const project={id:'x1',nodeId:'node-project',serverId:'local-node'};
const sample={time:now-1000,operationId:'op',requestId:'req',operation:'session.open',
    stage:'execution',result:'failure',code:'SESSION_NOT_FOUND',durationMs:15,body:'Private payload'};

it('returns only allowlisted fields from the admin project and the matching local Cells project',async()=>{
    const httpd=vi.fn(async()=>[
        {...sample,projectId:'x1',userId:'admin',url:'https://secret.invalid'},
        {...sample,projectId:'x1',userId:'another-user'},
        {...sample,projectId:'other',userId:'admin'}, {...sample,projectId:'x1'},
        {...sample,projectId:'x1',userId:'admin',time:now-3_600_000},
        {...sample,projectId:'x1',userId:'admin',requestId:'other'},
    ]);
    const cells=vi.fn(async()=>[
        {time:now-500,event:'harness.operation',fields:{projectId:'node-project',operation_id:'op',request_id:'child',parentRequestId:'req',result:'success',token:'CL1'}},
        {time:now-500,fields:{...sample,projectId:'other'}},
        {time:now-500,fields:{...sample,projectId:'node-project',serverProjectId:'other'}},
    ]);
    const result=await projectServiceDiagnostics(project,{operationId:'op',requestId:'req'},{httpd,cells},now);
    expect(result).toEqual({sources:{httpd:'read',cells:'read'},records:[
        expect.objectContaining({source:'cells',operation:'harness.operation',result:'success'}),
        expect.objectContaining({source:'httpd',operation:'session.open',code:'SESSION_NOT_FOUND',durationMs:15}),
    ]});
    expect(cells).toHaveBeenCalledWith(now-30*60_000,'local-node');
    expect(JSON.stringify(result)).not.toMatch(/Private payload|secret\.invalid|CL1|another-user|node-project/);
});

it('rejects an unbounded or invalid query before touching either source',async()=>{
    const read=vi.fn(async()=>[]);
    for(const query of [{},{operationId:'../forbidden/path'},{requestId:'req',minutes:121},{requestId:'req',limit:51}]){
        await expect(projectServiceDiagnostics(project,query,{httpd:read,cells:read},now))
            .rejects.toMatchObject({code:'SERVICE_DIAGNOSTICS_QUERY_INVALID'});
    }
    expect(read).not.toHaveBeenCalled();
});

it('returns the available source when journal access or verified Cells identity is unavailable',async()=>{
    const cells=vi.fn(async()=>{throw new Error('Private journal error');});
    const httpd=vi.fn(async()=>[{...sample,projectId:'x1',userId:'admin'}]);
    await expect(projectServiceDiagnostics(project,{operationId:'op',limit:1},{httpd,cells},now))
        .resolves.toMatchObject({sources:{httpd:'read',cells:'unavailable'},records:[{source:'httpd'}]});
});

it('does not open a source excluded by project settings',async()=>{
    const httpd=vi.fn(async()=>[]),cells=vi.fn(async()=>[]);
    await expect(projectServiceDiagnostics(project,{operationId:'op'},{httpd,cells},now,['cells']))
        .resolves.toEqual({sources:{httpd:'disabled',cells:'read'},records:[]});
    expect(httpd).not.toHaveBeenCalled();
    expect(cells).toHaveBeenCalledOnce();
});
