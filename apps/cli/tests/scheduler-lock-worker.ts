import { acquireRunSchedulerLock } from '../src/run-scheduler-lock';
const release = await acquireRunSchedulerLock(process.argv[2]);
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.once('data', () => { release(); process.exit(0); });
