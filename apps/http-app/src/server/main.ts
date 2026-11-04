import { runHttpHost, reportHttpStartupFailure } from '@nestos/node-host/http';
import { fileURLToPath } from 'node:url';
const staticDir = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/' : '../dist/', import.meta.url));
runHttpHost(process.argv.slice(2), staticDir).catch(error => { reportHttpStartupFailure(error); process.exitCode = 1; });
