import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {reportTransferScript} from '../../kanban-development/src/report-transfer-script';

it('counts eligible files over budget without packaging or including excluded directories',()=>{
    const source=mkdtempSync(join(tmpdir(),'kanban-report-usage-'));
    const root=join(source,'_nestos/kanban');
    try{
        mkdirSync(join(root,'artifacts/runs/dist'),{recursive:true});
        writeFileSync(join(root,'artifacts/runs/dist/ignored'),Buffer.alloc(40));
        writeFileSync(join(root,'artifacts/runs/evidence'),Buffer.alloc(12));
        writeFileSync(join(root,'handoff.md'),'abc');
        const output=execFileSync('python3',['-c',reportTransferScript,JSON.stringify({source,target:source,mode:'usage',maxFiles:1,maxBytes:10})]);
        expect(JSON.parse(output.toString())).toEqual({files:2,bytes:15,maxFiles:1,maxBytes:10,
            directories:[{path:'artifacts/runs',files:1,bytes:12},{path:'.',files:1,bytes:3}]});
    }finally{rmSync(source,{recursive:true,force:true});}
});


it('reconciles the same existing archive and does not package changed evidence',()=>{
    const source=mkdtempSync(join(tmpdir(),'kanban-report-reconcile-')),target=join(source,'delivery');
    const evidence=join(source,'_nestos/kanban/artifacts/evidence.md');
    const config={source,target,maxFiles:20,maxBytes:1024,resourceId:'worktree',owner:{boardId:'board',itemId:'manager'}};
    const run=(mode:string,fingerprint?:string)=>spawnSync('python3',['-c',reportTransferScript,JSON.stringify({...config,mode,fingerprint})],{encoding:'utf8'});
    try{
        mkdirSync(join(source,'_nestos/kanban/artifacts'),{recursive:true});writeFileSync(evidence,'Proof');
        const fingerprint=JSON.parse(run('inspect').stdout).fingerprint;
        const original=JSON.parse(run('pack',fingerprint).stdout);
        expect(JSON.parse(run('reconcile').stdout)).toMatchObject({fingerprint,sha256:original.sha256,existing:true});
        writeFileSync(evidence,'New evidence');
        const refused=run('reconcile');
        expect(refused.status).toBe(1);
        expect(JSON.parse(refused.stdout).code).toBe('SOFTWARE_REPORT_HANDOFF_UNCONFIRMED');
        expect(readdirSync(target).sort()).toEqual([fingerprint+'.json',fingerprint+'.tar.gz']);
    }finally{rmSync(source,{recursive:true,force:true});}
});


it('returns a bounded receipt while retaining the complete archive manifest on disk',()=>{
    const source=mkdtempSync(join(tmpdir(),'kanban-report-large-receipt-')),target=join(source,'delivery');
    const reports=join(source,'_nestos/kanban/artifacts');
    const config={source,target,maxFiles:2000,maxBytes:268435456,resourceId:'worktree',owner:{boardId:'board',itemId:'manager'}};
    const run=(mode:string,fingerprint?:string)=>execFileSync('python3',['-c',reportTransferScript,JSON.stringify({...config,mode,fingerprint})]);
    try{
        mkdirSync(reports,{recursive:true});
        for(let index=0;index<960;index++)writeFileSync(join(reports,`browser-evidence-${index}.md`),'Accepted evidence');
        const {fingerprint}=JSON.parse(run('inspect').toString()),packed=run('pack',fingerprint),reconciled=run('reconcile');
        const disk=readFileSync(join(target,fingerprint+'.json'));
        expect(disk.byteLength).toBeGreaterThan(64*1024);
        expect(JSON.parse(disk.toString()).files).toHaveLength(960);
        for(const receipt of [packed,reconciled]){
            expect(receipt.byteLength).toBeLessThan(1024);
            expect(JSON.parse(receipt.toString())).toMatchObject({fingerprint,fileCount:960});
        }
    }finally{rmSync(source,{recursive:true,force:true});}
});
