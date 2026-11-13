import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const checker=fileURLToPath(new URL('./check-node-native-runtime.mjs',import.meta.url));
const modules=['better-sqlite3','node-pty','sharp'];
function execute(command,args,cwd,env) {
    const result=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:16*1024*1024});
    if(result.error)throw result.error;
    return {status:result.status,output:(result.stdout??'')+(result.stderr??'')};
}
/** Native outputs belong to this installation, never to a previous release or another checkout. */
export function ensureNativeRuntime(source,{operationId='unknown',env=process.env,log=console.log,runCommand=execute}={}) {
    const started=Date.now(),app=path.join(source,'apps/http-app');
    const probe=()=>runCommand(process.execPath,[checker,app],source,env);
    const initial=probe();
    if(initial.status===0){log(`[HTTPBuild] operationId=${operationId} stage=native.prepare result=success cache=hit durationMs=${Date.now()-started}`);return;}
    const failed=modules.filter(name=>initial.output.includes(`package=${name} result=failure`));
    const selected=failed.length?failed:modules;
    log(`[HTTPBuild] operationId=${operationId} stage=native.prepare result=rebuild packages=${selected.join(',')} node=${process.version} abi=${process.versions.modules} platform=${process.platform} arch=${process.arch}`);
    const rebuilt=runCommand('pnpm',['--config.ignore-scripts=false','--filter','@nestos/http-app','rebuild',...selected],source,env);
    if(rebuilt.output)log(rebuilt.output);
    const checked=rebuilt.status===0?probe():rebuilt;
    if(checked.status!==0){
        const missingMake=/not found: make|make: (?:command )?not found|spawn make ENOENT/i.test(checked.output);
        const code=missingMake?'NATIVE_BUILD_TOOLCHAIN_MISSING':'NATIVE_RUNTIME_PREPARATION_FAILED';
        const remedy=missingMake?' Install build-essential and python3 in the build environment; then retry the build.':'';
        log(`[HTTPBuild] operationId=${operationId} stage=native.prepare result=failure packages=${selected.join(',')} code=${code}${missingMake?' missing=make':''} durationMs=${Date.now()-started}`);
        throw Object.assign(new Error(`${code}: ${selected.join(',')}; ${checked.output.trim()}${remedy}`),{code,...(missingMake?{missingTools:['make']}:{})});
    }
    log(`[HTTPBuild] operationId=${operationId} stage=native.prepare result=success cache=rebuilt durationMs=${Date.now()-started}`);
}
