import {temporaryScope} from '../node/index.mjs';
import {fileURLToPath} from 'node:url';
const [directory, output] = process.argv.slice(2);
const scope = await temporaryScope({directory, scopeId: 'crash-fixture'});
const handle = await scope.start(process.execPath, [fileURLToPath(new URL('command.mjs', import.meta.url)), output], {timeoutMs: 30000});
handle.result.catch(() => {});
process.send({id: handle.id});
// Keep the owner alive until the fault-injection test terminates it.
setInterval(() => {}, 1000);
