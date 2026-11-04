import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [output, mode] = process.argv.slice(2);
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
// A new session would escape a process-group-only cleanup. PID namespaces contain it.
const child = spawn(process.execPath, ['-e', "require('node:http').createServer((q,s)=>s.end('descendant')).listen(0,'127.0.0.1',function(){process.send({port:this.address().port})})"], {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
child.once('message', message => {
    const server = createServer((_request, response) => {response.end('temporary');});
    server.listen(0, '127.0.0.1', () => writeFileSync(output, JSON.stringify({pid: process.pid, child: child.pid, port: server.address().port, childPort: message.port})));
});
