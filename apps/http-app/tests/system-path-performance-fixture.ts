import {access, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {openLocalFSBackend} from '@nestos/vfsdriver-local';
import {NodeFsOps} from '@nestos/vfsdriver-local/node';
import {instrumentStorage, type StorageEvent} from './system-path-performance-storage';
import {NodeSqliteSidecarDb} from '@nestos/node-host/storage';
import {createCertificates} from '@nestos/node-host/http';
import {RoundLog} from '../../../backend/llm-session/src/persistence/round-log';
import {folderBrowserPath} from '@nestos/app-contracts';
import {createNodeRuntime} from '../../node-host/src/runtime/application';
import {RuntimeApi} from '../../node-host/src/http/runtime-api';
import {close, secureServers} from './tls-fixture';

const [directory, ui, endpoint, work] = process.argv.slice(2);
if (!directory || !ui || !endpoint || !work) throw new Error('FIXTURE_ARGUMENTS_REQUIRED');
const certs = path.join(directory, 'certs'), data = path.join(directory, 'data');
await mkdir(directory, {recursive:true});
await createCertificates(certs, ['127.0.0.1']);
const storageEvents: StorageEvent[] = [];
const backend = await openLocalFSBackend({rootDir:data, sidecarDir:path.join(directory,'meta'),
    createFs:() => instrumentStorage(new NodeFsOps(),'fs',storageEvents),
    createDb:async file => instrumentStorage(await NodeSqliteSidecarDb.open(file),'sidecar',storageEvents)});
const events: Array<{event?: string; operation?: string; route?: string; result?: string; timestamp: number}> = [];
const audit = {write(event: {event?: string; operation?: string; route?: string; result?: string}) {events.push({event:event.event, operation:event.operation, route:event.route, result:event.result, timestamp:Date.now()});}, close:async () => {}};
const runtime = await createNodeRuntime(backend, data, {startupMode:'server', ownerKind:'httpd'}, {dataDirectory:path.join(directory,'tool-data'),preferencesFile:path.join(directory,'tool-config/preferences.json'),registryFile:path.join(directory,'tool-config/registry.json'),directories:[]}, true, audit);
const mounts = runtime.projects.remoteMounts!;
const connection = await mounts.saveConnection({name:'Fixture Cells',endpoint}, 'fixture-system-path-token-at-least-24-bytes');
const project = await runtime.projects.createRemote('Path fixture', null, connection, '/work', 'rw', {projectId:'path-fixture'});
const session = await runtime.sessionRepository.createSession('Path fixture conversation', await runtime.projects.sessionFolder(project));
const displayedPath = path.join(work,'tools/cells/src/http/agent_mcp.rs') + ':26';
const api = new RuntimeApi(Promise.resolve(runtime), audit);
const server = await secureServers(backend,data,ui,certs,api);
const httpsPath = server.origin + displayedPath;
await new RoundLog(runtime.sessionRepository, session).append('main', {id:'fixture-round', sessionId:session, executions:[], historyParentIds:[], origin:'user', status:'completed', createdAt:1,
    input:[{role:'user',content:'Open the source location.'}], output:[{role:'assistant',content:`Command output: ${displayedPath}\n\nHTTPS path: ${httpsPath}`}]});
const resource = `${folderBrowserPath(project.path)}/${session}`;
await writeFile(path.join(directory,'ready.json'), JSON.stringify({origin:server.origin,certs,resource,displayedPath,httpsPath,expectedLine:'// PATH_FIXTURE_LINE_26'}));
let stopping = false;
async function stop() {
    if (stopping) return; stopping = true;
    clearInterval(timer); await api.close(); await close(server.server); await backend.close();
    await writeFile(path.join(directory,'audit.json'), JSON.stringify({events,storageEvents}));
    process.exit(0);
}
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
const timer = setInterval(() => {void access(path.join(directory,'stop')).then(stop).catch(() => {});}, 100);
