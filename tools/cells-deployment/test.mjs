import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServiceControl} from './index.mjs';
import {packageArtifact,digest,save} from './artifact.mjs';
import {build, deploymentConfiguration, parseRedeployArgs, readConfiguration, redeploy, sameDirectory, sameExecutablePath, targetsFor, vmConfigurationSource} from './redeploy.mjs';
import {command, serviceStorage} from './guest.mjs';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'cells-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root+'/tools/cells/target/release',{recursive:true});await writeFile(root+'/tools/cells/target/release/cells','candidate');
 await writeFile(root+'/running','original');const value=await packageArtifact(root,'a'.repeat(40));
 const options={id:'service',vm:'cell',root,executable:root+'/running',identity:'/key',stateDirectory:root+'/private',server:'/server'};
 let hash=digest(Buffer.from('original')),calls=0;
 const ports={ready:async()=>true,hash:async()=>hash,command:async()=>{calls++;hash=value.value.sha256;}};
 const control=await createServiceControl(options,ports),request={operationId:'replace',serviceId:'service',expectedVersion:(await control.describe()).version,targetVersion:value.value.id};
 const verify=()=>control.verifyArtifact({operationId:'build',serviceId:'service',version:value.value.id,sha256:value.digest});
 return {control,options,ports,request,value,verify,calls:()=>calls,setHash:value=>{hash=value;}};
}
test('verifies artifacts, switches only the bound VM and recovers the same receipt without replay',async t=>{
 const f=await fixture(t);await assert.rejects(f.control.submit(f.request),{code:'SERVICE_ARTIFACT_NOT_VERIFIED'});
 await assert.rejects(f.control.verifyArtifact({operationId:'build',serviceId:'service',version:f.value.value.id,sha256:f.value.digest,sourceVersion:'wrong'}),{code:'OPERATION_RESULT_SOURCE_CHANGED'});
 await f.verify();await f.control.submit(f.request);assert.equal(f.calls(),1);
 assert.deepEqual(await f.control.inspect(f.request),{state:'succeeded',version:f.request.targetVersion});
 const recovered=await createServiceControl(f.options,f.ports);await recovered.submit(f.request);assert.equal(f.calls(),1);
 assert.equal((await recovered.describe()).version,f.request.targetVersion);
 await assert.rejects(recovered.submit({...f.request,targetVersion:'changed'}),{code:'SERVICE_REQUEST_CHANGED'});
});
test('rejects target drift and artifact modification before switching',async t=>{
 const f=await fixture(t);await f.verify();
 await assert.rejects(f.control.submit({...f.request,expectedVersion:'stale'}),{code:'SERVICE_VERSION_CHANGED'});
 await writeFile(f.value.binary,'tampered');await assert.rejects(f.control.submit(f.request),{code:'SERVICE_ARTIFACT_INVALID'});assert.equal(f.calls(),0);
});
test('preserves unknown replacement and serializes later switches until its health is proven',async t=>{
 const f=await fixture(t);await f.verify();f.ports.command=async()=>{throw Object.assign(Error('timeout'),{code:'SERVICE_COMMAND_TIMEOUT'});};
 const control=await createServiceControl(f.options,f.ports);await control.submit(f.request);
 assert.deepEqual(await control.inspect(f.request),{state:'running'});
 await assert.rejects(control.submit({...f.request,operationId:'second'}),{code:'SERVICE_OPERATION_PENDING'});
 f.setHash(f.value.value.sha256);assert.deepEqual(await control.inspect(f.request),{state:'succeeded',version:f.request.targetVersion});
});
test('uses a SQLite OS lock to reject concurrent controllers before a second mutation',async t=>{
 const f=await fixture(t);await f.verify();let release;f.ports.command=()=>new Promise(resolve=>{release=resolve;});
 const first=f.control.submit(f.request);while(!release)await new Promise(resolve=>setTimeout(resolve,2));
 const second=await createServiceControl(f.options,f.ports);await assert.rejects(second.submit({...f.request,operationId:'other'}));
 f.setHash(f.value.value.sha256);release();await first;
});

test('redeploy defaults to both targets and builds a shared artifact once', async t => {
 const f=await fixture(t);
 const root=f.options.root, calls=[];
 const controlFor=async (_root,target)=>{
  let hash=digest(Buffer.from('original'));
  return createServiceControl({...f.options,id:target,stateDirectory:root+'/'+target,keepPrevious:true},{
   ready:async()=>true,hash:async()=>hash,restart:async()=>{
    calls.push(target);hash=digest(await readFile(f.options.executable));
   },
  });
 };
 let builds=0;
 const report=await redeploy(root,targetsFor(),{controlFor,build:async()=>{builds++;return f.value;}});
 assert.equal(builds,1);
 assert.deepEqual(calls,['cells-x1','local']);
 assert.deepEqual(report.targets.map(row=>row.state),['succeeded','succeeded']);
 assert.equal(await readFile(root+'/cells-x1/previous-'+report.operationId,'utf8'),'original');
 await assert.rejects(readFile(root+'/local/previous-'+report.operationId),{code:'ENOENT'});
});

test('preflight failure prevents build and an unknown first restart prevents a second switch', async t => {
 const f=await fixture(t);
 let builds=0;
 const build=async()=>{builds++;return f.value;};
 const controlFor=async (_root,target)=>{
  if(target==='local')throw Object.assign(Error('inactive'),{code:'SERVICE_NOT_READY'});
  return {describe:async()=>({version:'old'})};
 };
 const blocked=await redeploy(f.options.root,targetsFor(),{controlFor,build});
 assert.equal(builds,0);
 assert.deepEqual(blocked.targets.map(row=>row.state),['skipped','failed']);
 let submissions=0;
 const pending=await redeploy(f.options.root,targetsFor(),{build,controlFor:async()=>({
  describe:async()=>({version:'old'}),verifyArtifact:async()=>{},
  submit:async()=>{submissions++;},inspect:async()=>({state:'running'}),
 })});
 assert.equal(submissions,1);
 assert.deepEqual(pending.targets.map(row=>row.state),['running','skipped']);
});

test('does not replace or restart when the installed and running binary both match', async t => {
 const f=await fixture(t);
 const binary=await readFile(f.value.binary);
 await writeFile(f.options.executable,binary);
 f.setHash(f.value.value.sha256);
 const request={...f.request,expectedVersion:(await f.control.describe()).version};
 await f.verify();
 await f.control.submit(request);
 assert.equal(f.calls(),0);
 assert.deepEqual(await f.control.inspect(request),{state:'succeeded',version:request.targetVersion,changed:false});
 assert.deepEqual(await f.control.inspectOperation(request.operationId),{state:'succeeded',version:request.targetVersion,changed:false});
});
test('accepts aliases of the same checkout and rejects a different executable',async t=>{
 const f=await fixture(t), root=f.options.root, alias=root+'/alias';
 await symlink(root,alias);
 await mkdir(root+'/other');
 assert.equal(await sameDirectory(root,alias),true);
 assert.equal(await sameDirectory(root,root+'/other'),false);
 assert.equal(await sameExecutablePath(root+'/running (deleted)',alias+'/running'),true);
 assert.equal(await sameExecutablePath(root+'/other/running',alias+'/running'),false);
 assert.equal(await sameExecutablePath(root+'/different',alias+'/running'),false);
});
test('continues the second target when the first is unchanged', async t => {
 const f=await fixture(t);
 const order=[];
 const report=await redeploy(f.options.root,targetsFor(),{build:async()=>f.value,controlFor:async (_root,target)=>({
  describe:async()=>({version:'old'}),verifyArtifact:async()=>{},
  submit:async()=>{order.push(target);},
  inspect:async()=>({state:'succeeded',changed:target!=='cells-x1'}),
 })});
 assert.deepEqual(order,targetsFor());
 assert.deepEqual(report.targets.map(row=>row.state),['unchanged','succeeded']);
});

test('installs a verified binary beside the private config and keeps the prior executable', async t => {
 const f=await fixture(t);
 const root=f.options.root;
 await writeFile(root+'/cells','original');
 await writeFile(root+'/cells.toml','private config',{mode:0o600});
 const storage=serviceStorage(([file,...args],input)=>command(file,args,15000,input),root);
 assert.equal(await storage.installedHash(),digest(Buffer.from('original')));
 await assert.rejects(storage.install({...f.value,binary:root+'/cells.toml'},f.request),
  {code:'CELLS_INSTALL_DIGEST_MISMATCH'});
 assert.equal(await readFile(root+'/cells','utf8'),'original');
 await assert.rejects(readFile(root+'/previous-'+f.request.operationId),{code:'ENOENT'});
 await storage.install(f.value,f.request);
 assert.equal(await storage.installedHash(),f.value.value.sha256);
 assert.equal(await readFile(root+'/previous-'+f.request.operationId,'utf8'),'original');
 assert.equal(await readFile(root+'/cells.toml','utf8'),'private config');
});

test('switches a configuration-only release and verifies the new running generation', async t => {
 const f=await fixture(t), config=Buffer.from('private desired config'), oldConfig=digest(Buffer.from('old config'));
 const binary=f.value.value.sha256;
 let generation='before',installed=oldConfig,restarts=0;
 f.ports.process=async()=>({hash:binary,generation});
 f.ports.hash=async()=>binary;
 f.ports.installedHash=async()=>binary;
 f.ports.configHash=async()=>installed;
 f.ports.install=async(_artifact,request,bytes)=>{assert.equal(digest(bytes),request.configSha256);installed=digest(bytes);};
 f.ports.restart=async()=>{restarts++;throw Object.assign(Error('timeout'),{code:'SERVICE_COMMAND_TIMEOUT'});};
 const control=await createServiceControl(f.options,f.ports);
 const request={...f.request,expectedVersion:(await control.describe()).version,configSha256:digest(config),expectedConfigSha256:oldConfig};
 await f.verify();
 await control.submit(request,config);
 assert.deepEqual(await control.inspectOperation(request.operationId),{state:'running'});
 const row=await readFile(f.options.stateDirectory+'/operation-'+request.operationId+'.json','utf8');
 assert.equal(row.includes(config.toString()),false);
 generation='after';
 const recovered=await createServiceControl(f.options,f.ports);
 assert.deepEqual(await recovered.inspectOperation(request.operationId),{state:'succeeded',version:request.targetVersion});
 await recovered.submit({...request,operationId:'again',expectedVersion:request.targetVersion,expectedConfigSha256:installed},config);
 assert.deepEqual(await recovered.inspectOperation('again'),{state:'succeeded',version:request.targetVersion,changed:false});
 assert.equal(restarts,1);
});

test('stages and verifies both files before changing either and preserves private backups', async t => {
 const f=await fixture(t), root=f.options.root;
 const originalConfig=Buffer.from('original private config'), config=Buffer.from('new private config');
 await writeFile(root+'/cells','original');
 await writeFile(root+'/cells.toml',originalConfig,{mode:0o600});
 const binary=Buffer.from('#!/bin/sh\n[ "$1" = --check-config ] && ! grep -q invalid "$2"\n');
 await writeFile(root+'/candidate',binary);
 const artifact={binary:root+'/candidate',value:{sha256:digest(binary)}};
 const storage=serviceStorage(([file,...args],input)=>command(file,args,15000,input),root);
 const request={...f.request,configSha256:digest(config),expectedConfigSha256:digest(originalConfig)};
 await assert.rejects(storage.install(artifact,request,Buffer.from('tampered')),{code:'CELLS_CONFIG_DIGEST_MISMATCH'});
 const invalid=Buffer.from('invalid config');
 await assert.rejects(storage.install(artifact,{...request,configSha256:digest(invalid)},invalid),{code:'CELLS_CONFIG_INVALID'});
 assert.equal(await readFile(root+'/cells','utf8'),'original');
 assert.deepEqual(await readFile(root+'/cells.toml'),originalConfig);
 await storage.install(artifact,request,config);
 assert.equal(await storage.configHash(),request.configSha256);
 assert.deepEqual(await readFile(root+'/cells'),binary);
 assert.deepEqual(await readFile(root+'/previous-'+request.operationId+'.toml'),originalConfig);
 assert.equal((await stat(root+'/previous-'+request.operationId+'.toml')).mode & 0o777,0o600);
 assert.equal(await readFile(root+'/previous-'+request.operationId,'utf8'),'original');
});

test('validates both independent configurations before submitting either deployment', async t => {
 const f=await fixture(t), targets=targetsFor(), validated=[], submitted=[];
 const controlFor=async (_root,target)=>({target,describe:async()=>({version:'old'}),
  verifyArtifact:async()=>{},submit:async(request,config)=>submitted.push({target,request,config:config.toString()}),
  inspect:async()=>({state:'succeeded'}),
 });
 const deploymentConfiguration=async control=>{
  const bytes=Buffer.from(control.target);
  return {bytes,sha256:digest(bytes),previous:digest(Buffer.from('old '+control.target))};
 };
 const base={build:async()=>f.value,controlFor,deploymentConfiguration};
 const blocked=await redeploy(f.options.root,targets,{...base,validateConfig:async(_binary,config)=>{
  if(config.toString()==='local')throw Object.assign(Error('invalid'),{code:'CELLS_CONFIG_INVALID'});
 }});
 assert.equal(submitted.length,0);
 assert.deepEqual(blocked.targets.map(row=>row.state),['skipped','failed']);
 await redeploy(f.options.root,targets,{...base,validateConfig:async(_binary,config)=>validated.push(config.toString())});
 assert.deepEqual(validated,targets);
 assert.deepEqual(submitted.map(row=>[row.target,row.config,row.request.configSha256]),
  targets.map(target=>[target,target,digest(Buffer.from(target))]));
});


test('accepts a private target config and rejects symlinks or readable copies', async t => {
 const f=await fixture(t), file=f.options.root+'/target.toml';
 await writeFile(file,'private',{mode:0o600});
 await writeFile(file+'.public','public'); await chmod(file+'.public',0o644);
 await symlink(file,file+'.link');
 assert.equal((await readConfiguration(file)).toString(),'private');
 await assert.rejects(readConfiguration(file+'.public'),{code:'CELLS_CONFIG_SOURCE_INVALID'});
 await assert.rejects(readConfiguration(file+'.link'),{code:'CELLS_CONFIG_SOURCE_UNAVAILABLE'});
 await assert.rejects(readConfiguration(undefined),{code:'CELLS_CONFIG_SOURCE_REQUIRED'});
});


test('uses the existing Firecracker service manifest as the VM configuration source', async t => {
 const f=await fixture(t), directory=f.options.root+'/service-sources', parent=directory+'/cells-x1';
 await mkdir(parent,{recursive:true});
 await writeFile(parent+'/service.toml',[
  'id = "cells-x1"', '[[files]]', 'source = "old.toml"', 'target = "config.toml"',
  '[[files]]', 'source = "guest.toml"', 'target = "cells.toml"',
 ].join('\n'));
 await chmod(parent+'/service.toml',0o644);
 await writeFile(parent+'/guest.toml','private VM configuration',{mode:0o600});
 const resolved=await vmConfigurationSource('cells-x1',undefined,directory);
 assert.equal(resolved,parent+'/guest.toml');
 assert.equal((await readConfiguration(resolved)).toString(),'private VM configuration');
 assert.equal(await vmConfigurationSource('cells-x1','/private/override.toml',directory),'/private/override.toml');
});

test('rejects a mismatched manifest and configuration sources that escape or are ambiguous', async t => {
 const f=await fixture(t), directory=f.options.root+'/service-sources', parent=directory+'/cells-x1';
 await mkdir(parent,{recursive:true});
 const resolve=()=>vmConfigurationSource('cells-x1',undefined,directory);
 await assert.rejects(resolve(),{code:'CELLS_CONFIG_MANIFEST_UNAVAILABLE'});
 await writeFile(parent+'/service.toml','id="other"');
 await assert.rejects(resolve(),{code:'CELLS_CONFIG_MANIFEST_INVALID'});
 await writeFile(parent+'/service.toml','id="cells-x1"\n[[files]]\nsource="../local.toml"\ntarget="cells.toml"');
 await assert.rejects(resolve(),{code:'CELLS_CONFIG_SOURCE_INVALID'});
 await writeFile(parent+'/service.toml','id="cells-x1"\n[[files]]\nsource="guest.toml"\ntarget="cells.toml"\n[[files]]\nsource="other.toml"\ntarget="cells.toml"');
 await assert.rejects(resolve(),{code:'CELLS_CONFIG_MANIFEST_SOURCE_AMBIGUOUS'});
});


test('redeploys with the installed guest configuration when the default manifest is unavailable', async t => {
 const f=await fixture(t), root=f.options.root, sourceDir=root+'/service-sources';
 const config=Buffer.from('existing guest configuration');
 const read=async()=>config, submitted=[];
 const controlFor=async()=>({
  options:{id:'cells-x1'}, describe:async()=>({version:'old'}),
  installedConfiguration:read, verifyArtifact:async()=>{},
  submit:async(request,bytes)=>submitted.push({request,bytes}),
  inspect:async()=>({state:'succeeded'}),
 });
 const report=await redeploy(root,['cells-x1'],{
  build:async()=>f.value,controlFor,validateConfig:async(_binary,bytes)=>assert.deepEqual(bytes,config),
  deploymentConfiguration:control=>deploymentConfiguration(control,id=>vmConfigurationSource(id,undefined,sourceDir)),
 });
 assert.equal(report.targets[0].state,'succeeded');
 assert.equal(submitted.length,1);
 assert.deepEqual(submitted[0].bytes,config);
 assert.equal(submitted[0].request.configSha256,digest(config));
 assert.equal(submitted[0].request.expectedConfigSha256,digest(config));
});

test('does not fall back if an explicit VM config or readable manifest is invalid', async t => {
 const f=await fixture(t), root=f.options.root, sourceDir=root+'/service-sources';
 const parent=sourceDir+'/cells-x1';
 await mkdir(parent,{recursive:true});
 const control={options:{id:'cells-x1',configSource:parent+'/missing.toml'},installedConfiguration:async()=>assert.fail('unexpected guest fallback')};
 await assert.rejects(deploymentConfiguration(control),{code:'CELLS_CONFIG_SOURCE_UNAVAILABLE'});
 delete control.options.configSource;
 await writeFile(parent+'/service.toml','not valid TOML');
 await assert.rejects(deploymentConfiguration(control,id=>vmConfigurationSource(id,undefined,sourceDir)),{code:'CELLS_CONFIG_MANIFEST_INVALID'});
});

test('reads the bounded guest configuration snapshot without changing its bytes', async t => {
 const f=await fixture(t), root=f.options.root;
 const config=Buffer.from('private configuration\n');
 await writeFile(root+'/cells','original');
 await writeFile(root+'/cells.toml',config,{mode:0o600});
 const storage=serviceStorage(([file,...args],input,maxBuffer)=>command(file,args,15000,input,maxBuffer),root);
 assert.deepEqual(await storage.readConfiguration(),config);
 await writeFile(root+'/cells.toml',Buffer.alloc(1024*1024+1));
 await assert.rejects(storage.readConfiguration(),{code:'CELLS_CONFIG_INSTALLED_INVALID'});
});

test('a project-bound Cells update verifies saved executable and config across restart',async t=>{
 const f=await fixture(t),config=Buffer.from('private guest configuration'),project={serverId:'node',serverProjectId:'self',principalId:'owner',alias:'prj',root:'/x1'};
 const git=(...args)=>execFileSync('git',['-C',f.options.root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 git('init','-q');git('-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','Fixture');
 const sourceVersion=git('rev-parse','HEAD'),artifact=await packageArtifact(f.options.root,sourceVersion);
 let hash=digest(Buffer.from('original')),generation='old',restarts=0;
 f.ports.process=async()=>({hash,generation});
 f.ports.hash=async()=>hash;
 f.ports.installedHash=async()=>artifact.value.sha256;
 f.ports.readConfiguration=async()=>config;
 f.ports.configHash=async()=>digest(config);
 f.ports.install=async(_value,request,bytes)=>{assert.equal(request.configSha256,digest(config));assert.deepEqual(bytes,config);};
 f.ports.restart=async()=>{hash=artifact.value.sha256;generation='new';restarts++;};
 const controller=await createServiceControl(f.options,f.ports),request={...f.request,targetVersion:artifact.value.id,project};
 await assert.rejects(controller.verifyArtifact({operationId:'build',serviceId:'service',version:artifact.value.id,sha256:artifact.digest,project}),
  {code:'SERVICE_SOURCE_COMMIT_UNVERIFIED'});
 await controller.verifyArtifact({operationId:'build',serviceId:'service',version:artifact.value.id,sha256:artifact.digest,sourceVersion,project});
 await controller.submit(request);
 const recovered=await createServiceControl(f.options,f.ports);
 assert.deepEqual(await recovered.inspect(request),{state:'succeeded',version:request.targetVersion});
 await recovered.submit(request);assert.equal(restarts,1);
 await assert.rejects(recovered.inspect({...request,project:{...project,root:'/other'}}),{code:'SERVICE_REQUEST_CHANGED'});
});

test('scopes build source cleanliness to tools/cells instead of unrelated workspace files', async t => {
 const root = await mkdtemp(path.join(tmpdir(), 'cells-build-scope-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
 const commit = (dir, message) => git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', message);
 const submodule = path.join(root, 'cells-upstream');
 await mkdir(submodule, {recursive: true});
 git(submodule, 'init', '-q');
 await writeFile(path.join(submodule, 'Cargo.toml'), '[package]\nname="cells"\n');
 git(submodule, 'add', '.');
 commit(submodule, 'Initial cells');
 const workspace = path.join(root, 'workspace');
 await mkdir(path.join(workspace, 'backend'), {recursive: true});
 git(workspace, 'init', '-q');
 await writeFile(path.join(workspace, 'backend/app.ts'), 'export const v = 1;\n');
 execFileSync('git', ['-C', workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submodule, 'tools/cells'], {stdio: 'ignore'});
 git(workspace, 'add', '.');
 commit(workspace, 'Initial workspace');
 const compile = async ({output}) => {
  await mkdir(path.join(output, 'release'), {recursive: true});
  await writeFile(path.join(output, 'release/cells'), 'compiled-binary');
 };
 await writeFile(path.join(workspace, 'backend/app.ts'), 'export const v = 2;\n');
 const built = await build(workspace, compile);
 assert.equal(built.value.commit, git(workspace, 'rev-parse', 'HEAD'));
 const cellsDir = path.join(workspace, 'tools/cells');
 await writeFile(path.join(cellsDir, 'Cargo.toml'), '[package]\nname="cells"\nversion="0.1.1"\n');
 await assert.rejects(build(workspace, compile), {code: 'BUILD_SOURCE_DIRTY'});
 git(cellsDir, 'add', 'Cargo.toml');
 commit(cellsDir, 'Advance cells submodule without updating parent');
 await assert.rejects(build(workspace, compile), {code: 'BUILD_SOURCE_DIRTY'});
 git(workspace, 'add', 'tools/cells');
 commit(workspace, 'Record updated cells submodule');
 await assert.rejects(build(workspace, async context => {
  await compile(context);
  await writeFile(path.join(cellsDir, 'Cargo.toml'), '[package]\nname="cells"\nversion="0.1.2"\n');
 }), {code: 'BUILD_SOURCE_CHANGED'});
});

test('parses redeploy arguments including --config-only in either position', () => {
 assert.deepEqual(parseRedeployArgs([]), {targets: ['cells-x1', 'local'], configOnly: false});
 assert.deepEqual(parseRedeployArgs(['local']), {targets: ['local'], configOnly: false});
 assert.deepEqual(parseRedeployArgs(['--config-only']), {targets: ['cells-x1', 'local'], configOnly: true});
 assert.deepEqual(parseRedeployArgs(['local', '--config-only']), {targets: ['local'], configOnly: true});
 assert.deepEqual(parseRedeployArgs(['--config-only', 'cells-x1']), {targets: ['cells-x1'], configOnly: true});
 assert.throws(() => parseRedeployArgs(['--config-only', '--config-only']), {code: 'CELLS_REDEPLOY_ARGUMENTS_INVALID'});
 assert.throws(() => parseRedeployArgs(['local', 'cells-x1']), {code: 'CELLS_REDEPLOY_ARGUMENTS_INVALID'});
 assert.throws(() => parseRedeployArgs(['--unknown']), {code: 'CELLS_REDEPLOY_ARGUMENTS_INVALID'});
});

test('validates and installs config-only updates without touching the binary or creating binary backups', async t => {
 const f = await fixture(t), root = f.options.root;
 const binary = Buffer.from('#!/bin/sh\n[ "$1" = --check-config ] && ! grep -q invalid "$2"\n');
 const originalConfig = Buffer.from('original private config'), nextConfig = Buffer.from('new private config');
 await writeFile(root + '/cells', binary, {mode: 0o755});
 await writeFile(root + '/cells.toml', originalConfig, {mode: 0o600});
 const storage = serviceStorage(([file, ...args], input) => command(file, args, 15000, input), root);
 const binaryHash = digest(binary);
 await storage.checkConfiguration(nextConfig);
 await assert.rejects(storage.checkConfiguration(Buffer.from('invalid config')), {code: 'CELLS_CONFIG_INVALID'});
 const request = {...f.request, configOnly: true, configSha256: digest(nextConfig), expectedConfigSha256: digest(originalConfig)};
 await assert.rejects(storage.installConfig(digest(Buffer.from('other')), request, nextConfig), {code: 'CELLS_INSTALL_DIGEST_MISMATCH'});
 await assert.rejects(storage.installConfig(binaryHash, {...request, expectedConfigSha256: digest(Buffer.from('stale'))}, nextConfig), {code: 'CELLS_CONFIG_CHANGED'});
 await assert.rejects(storage.installConfig(binaryHash, {...request, configSha256: digest(Buffer.from('invalid'))}, Buffer.from('invalid')), {code: 'CELLS_CONFIG_INVALID'});
 await storage.installConfig(binaryHash, request, nextConfig);
 assert.equal(await storage.configHash(), request.configSha256);
 assert.deepEqual(await readFile(root + '/cells'), binary);
 assert.deepEqual(await readFile(root + '/previous-' + request.operationId + '.toml'), originalConfig);
 assert.equal((await stat(root + '/previous-' + request.operationId + '.toml')).mode & 0o777, 0o600);
 await assert.rejects(readFile(root + '/previous-' + request.operationId), {code: 'ENOENT'});
});

test('redeploy --config-only skips build, validates all targets first, and recovers across restart', async t => {
 const f = await fixture(t), root = f.options.root;
 const binaryHash = digest(Buffer.from('running-cells')), oldConfig = digest(Buffer.from('old'));
 const desired = Buffer.from('desired');
 let builds = 0, generation = 'before', installedConfig = oldConfig, installedBinary = binaryHash, restarts = 0, validated = 0;
 const controlFor = async (_root, target) => createServiceControl({...f.options, id: target, stateDirectory: root + '/state-' + target}, {
  ready: async () => true,
  hash: async () => binaryHash,
  process: async () => ({hash: binaryHash, generation}),
  installedHash: async () => installedBinary,
  configHash: async () => installedConfig,
  checkConfiguration: async bytes => {
   validated++;
   if (bytes.toString().includes('bad')) throw Object.assign(Error('bad'), {code: 'CELLS_CONFIG_INVALID'});
  },
  installConfig: async (hash, request, bytes) => {
   assert.equal(hash, binaryHash);
   assert.equal(digest(bytes), request.configSha256);
   installedConfig = digest(bytes);
  },
  restart: async () => {restarts++; generation = 'after';},
 });
 const blocked = await redeploy(root, ['local'], {
  build: async () => {builds++; return f.value;},
  controlFor,
  deploymentConfiguration: async () => ({bytes: Buffer.from('bad'), sha256: digest(Buffer.from('bad')), previous: oldConfig}),
 }, {configOnly: true});
 assert.equal(builds, 0);
 assert.equal(restarts, 0);
 assert.equal(blocked.mode, 'config-only');
 assert.deepEqual(blocked.targets, [{target: 'local', state: 'failed', code: 'CELLS_CONFIG_INVALID'}]);
 installedBinary = digest(Buffer.from('drifted-on-disk'));
 const drifted = await redeploy(root, ['local'], {
  build: async () => {builds++; return f.value;},
  controlFor,
  deploymentConfiguration: async () => ({bytes: desired, sha256: digest(desired), previous: oldConfig}),
 }, {configOnly: true});
 assert.equal(drifted.targets[0].code, 'CELLS_INSTALL_DIGEST_MISMATCH');
 assert.equal(restarts, 0);
 installedBinary = binaryHash;
 const report = await redeploy(root, ['local'], {
  build: async () => {builds++; return f.value;},
  controlFor,
  deploymentConfiguration: async () => ({bytes: desired, sha256: digest(desired), previous: oldConfig}),
 }, {configOnly: true});
 assert.equal(builds, 0);
 assert.equal(validated, 3);
 assert.equal(restarts, 1);
 assert.equal(report.version, undefined);
 assert.equal(report.targets[0].state, 'succeeded');
 const unchanged = await redeploy(root, ['local'], {
  build: async () => {builds++; return f.value;},
  controlFor,
  deploymentConfiguration: async () => ({bytes: desired, sha256: digest(desired), previous: installedConfig}),
 }, {configOnly: true});
 assert.equal(unchanged.targets[0].state, 'unchanged');
 assert.equal(restarts, 1);
});

test('skips cells compilation when tools/cells is unchanged and rebuilds when submodule advances', async t => {
 const root = await mkdtemp(path.join(tmpdir(), 'cells-build-cache-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], {encoding: 'utf8'}).trim();
 const commit = (directory, message) => execFileSync('git', ['-C', directory, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message], {stdio: 'ignore'});
 const submodule = path.join(root, 'cells-upstream');
 await mkdir(submodule, {recursive: true});
 git(submodule, 'init', '-q');
 await writeFile(path.join(submodule, 'Cargo.toml'), '[package]\nname="cells"\n');
 git(submodule, 'add', '.');
 commit(submodule, 'Initial cells');
 const workspace = path.join(root, 'workspace');
 await mkdir(path.join(workspace, 'backend'), {recursive: true});
 git(workspace, 'init', '-q');
 await writeFile(path.join(workspace, 'backend/app.ts'), 'export const v = 1;\n');
 execFileSync('git', ['-C', workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submodule, 'tools/cells'], {stdio: 'ignore'});
 git(workspace, 'add', '.');
 commit(workspace, 'Initial workspace');
 let compiles = 0;
 const compile = async ({output}) => {
  compiles++;
  await mkdir(path.join(output, 'release'), {recursive: true});
  await writeFile(path.join(output, 'release/cells'), `compiled-${compiles}`);
 };
 const first = await build(workspace, compile, {cache: true});
 assert.equal(compiles, 1);
 const second = await build(workspace, compile, {cache: true});
 assert.equal(compiles, 1);
 assert.equal(second.value.id, first.value.id);
 await writeFile(path.join(workspace, 'backend/app.ts'), 'export const v = 2;\n');
 git(workspace, 'add', 'backend/app.ts');
 commit(workspace, 'Unrelated backend change');
 const third = await build(workspace, compile, {cache: true});
 assert.equal(compiles, 1);
 assert.equal(third.value.commit, git(workspace, 'rev-parse', 'HEAD'));
 assert.equal(third.value.sha256, first.value.sha256);
 const cellsDir = path.join(workspace, 'tools/cells');
 await writeFile(path.join(cellsDir, 'Cargo.toml'), '[package]\nname="cells"\nversion="0.2.0"\n');
 git(cellsDir, 'add', 'Cargo.toml');
 commit(cellsDir, 'Advance cells');
 git(workspace, 'add', 'tools/cells');
 commit(workspace, 'Bump cells submodule');
 const fourth = await build(workspace, compile, {cache: true});
 assert.equal(compiles, 2);
 assert.notEqual(fourth.value.sha256, first.value.sha256);
});
