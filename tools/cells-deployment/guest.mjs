import {execFile} from 'node:child_process';
import {open,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {fail} from './artifact.mjs';

const exec = promisify(execFile);
export const installedExecutable = '/usr/local/lib/nestos/cells/cells';
export const installedConfig = '/usr/local/lib/nestos/cells/cells.toml';

export async function command(file, args, timeout = 15000, input, maxBuffer = 262144) {
    try {
        const result = exec(file, args, {timeout, maxBuffer, killSignal: 'SIGKILL'});
        if (input !== undefined) {
            result.child.stdin.on('error', () => {});
            result.child.stdin.end(input);
        }
        return (await result).stdout.trim();
    } catch (error) {
        const message = String(error.stderr ?? '');
        const code = error.killed ? 'SERVICE_COMMAND_TIMEOUT'
            : /no new privileges|password is required/.test(message) ? 'SERVICE_PRIVILEGE_UNAVAILABLE'
            : /Permission denied.*publickey/.test(message) ? 'SERVICE_SSH_AUTH_FAILED'
            : /Host key verification failed/.test(message) ? 'SERVICE_SSH_HOST_KEY_MISMATCH'
            : message.match(/^CELLS_(?:INSTALL|CONFIG)_[A-Z_]+$/m)?.[0] ?? 'SERVICE_COMMAND_EXIT_' + String(error.code ?? 'UNKNOWN');
        throw fail(code);
    }
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function ready(options) {
    const value = JSON.parse(await command('sudo', ['-n', options.server, 'service', 'status', options.vm]));
    if (value.service !== options.id || value.vm !== options.vm || value.rootDisk?.retained !== true)
        throw fail('SERVICE_BINDING_MISMATCH');
    return value.state === 'ready';
}

async function guestCommand(options, args, input, maxBuffer) {
    const address = await command('sudo', ['-n', options.server, 'network', 'address', options.vm]);
    const [ip, alias] = address.split(/\s+/);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^nestos-[\w-]+$/.test(alias)) throw fail('SERVICE_ADDRESS_INVALID');
    return command('sudo', ['-n', 'ssh', '-F', '/dev/null', '-T', '-i', options.identity,
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=/var/lib/nestos-firecracker/services/known_hosts',
        '-o', 'HostKeyAlias=' + alias, 'agent@' + ip, args.map(quote).join(' ')], 120000, input, maxBuffer);
}

const hashProcess = `import pathlib, hashlib, sys
target = sys.argv[1]
expected_config = sys.argv[2] if len(sys.argv) > 2 else None
rows = []
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdigit():
        continue
    try:
        e = p / 'exe'
        if str(e.readlink()).removesuffix(' (deleted)') != target:
            continue
        if expected_config and (p / 'cmdline').read_bytes().split(b'\\x00')[1:2] != [expected_config.encode()]:
            sys.exit('CELLS_CONFIG_BINDING_MISMATCH')
        with e.open('rb') as binary:
            start = (p / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            rows.append(hashlib.file_digest(binary, 'sha256').hexdigest() + ' ' + boot + ':' + p.name + ':' + start)
    except OSError:
        pass
if len(rows) != 1:
    sys.exit('CELLS_INSTALL_PROCESS_UNVERIFIED')
print(rows[0])
`;

export async function runningProcess(options) {
    const args = ['python3', '-c', hashProcess, options.executable];
    if (options.executable === installedExecutable) args.push(installedConfig);
    const output = await guestCommand(options, args);
    return {hash: checkedHash(output), generation: checkedGeneration(output.split(/\s+/)[1])};
}

export const runningHash = async options => (await runningProcess(options)).hash;

export function checkedGeneration(value) {
    if (!/^[a-f0-9-]{36}:[1-9]\d*:\d+$/.test(value ?? '')) throw fail('CELLS_INSTALL_PROCESS_UNVERIFIED');
    return value;
}

const verifyInstallation = `
check_file() {
    [ -f "$1" ] && [ ! -L "$1" ]
}
[ "$(realpath -- "$1")" = "$1" ] && cd "$1" ||
    { echo CELLS_INSTALL_DIRECTORY_UNAVAILABLE >&2; exit 1; }
filesystem=$(findmnt -T . -n -o FSTYPE)
case "$filesystem" in
    virtiofs|9p|nfs|nfs4|cifs|smb3)
    { echo CELLS_INSTALL_SHARED_FILESYSTEM >&2; exit 1; }
    ;;
esac
check_file cells ||
    { echo CELLS_INSTALL_EXECUTABLE_UNAVAILABLE >&2; exit 1; }
check_file cells.toml && [ "$(stat -c %a cells.toml)" = 600 ] ||
    { echo CELLS_CONFIG_FILE_UNAVAILABLE >&2; exit 1; }
`;

const installBinary = `${verifyInstallation}
[ "$3" = "$(sha256sum < cells | cut -d ' ' -f 1)" ] && exit 0
staged=$(mktemp .cells.XXXXXXXX)
trap 'rm -f -- "$staged"' EXIT
cat > "$staged"
[ "$3" = "$(sha256sum < "$staged" | cut -d ' ' -f 1)" ] ||
    { echo CELLS_INSTALL_DIGEST_MISMATCH >&2; exit 1; }
chmod 0755 "$staged"
sync "$staged"
ln -- cells "previous-$2"
mv -T -- "$staged" cells
sync -f .
`;

const installRelease = `${verifyInstallation}
operation=$2
binary_hash=$3
config_hash=$4
previous_config=$5
binary_size=$6
file_hash() { sha256sum < "$1" | cut -d ' ' -f 1; }
[ "$(file_hash cells.toml)" = "$previous_config" ] ||
    { echo CELLS_CONFIG_CHANGED >&2; exit 1; }
staging=$(mktemp -d .release.XXXXXXXX)
trap 'rm -rf -- "$staging"' EXIT
head -c "$binary_size" > "$staging/cells"
cat > "$staging/cells.toml"
[ "$(file_hash "$staging/cells")" = "$binary_hash" ] ||
    { echo CELLS_INSTALL_DIGEST_MISMATCH >&2; exit 1; }
[ "$(file_hash "$staging/cells.toml")" = "$config_hash" ] ||
    { echo CELLS_CONFIG_DIGEST_MISMATCH >&2; exit 1; }
chmod 0755 "$staging/cells"
chmod 0600 "$staging/cells.toml"
"$staging/cells" --check-config "$staging/cells.toml" >/dev/null 2>&1 ||
    { echo CELLS_CONFIG_INVALID >&2; exit 1; }
if [ "$(stat -c %u:%g cells.toml)" != "$(stat -c %u:%g "$staging/cells.toml")" ]; then
    chown --reference=cells.toml "$staging/cells.toml"
fi
sync "$staging/cells" "$staging/cells.toml"
ln -- cells "previous-$operation"
ln -- cells.toml "previous-$operation.toml"
sync -f .
mv -T -- "$staging/cells" cells
if ! mv -T -- "$staging/cells.toml" cells.toml; then
    ln -- "previous-$operation" "$staging/restore"
    mv -T -- "$staging/restore" cells
    sync -f .
    exit 1
fi
sync -f .
`;

const installConfigOnly = `${verifyInstallation}
operation=$2
binary_hash=$3
config_hash=$4
previous_config=$5
file_hash() { sha256sum < "$1" | cut -d ' ' -f 1; }
[ "$(file_hash cells)" = "$binary_hash" ] ||
    { echo CELLS_INSTALL_DIGEST_MISMATCH >&2; exit 1; }
[ "$(file_hash cells.toml)" = "$previous_config" ] ||
    { echo CELLS_CONFIG_CHANGED >&2; exit 1; }
staging=$(mktemp -d .config.XXXXXXXX)
trap 'rm -rf -- "$staging"' EXIT
cat > "$staging/cells.toml"
[ "$(file_hash "$staging/cells.toml")" = "$config_hash" ] ||
    { echo CELLS_CONFIG_DIGEST_MISMATCH >&2; exit 1; }
chmod 0600 "$staging/cells.toml"
./cells --check-config "$staging/cells.toml" >/dev/null 2>&1 ||
    { echo CELLS_CONFIG_INVALID >&2; exit 1; }
if [ "$(stat -c %u:%g cells.toml)" != "$(stat -c %u:%g "$staging/cells.toml")" ]; then
    chown --reference=cells.toml "$staging/cells.toml"
fi
sync "$staging/cells.toml"
ln -- cells.toml "previous-$operation.toml"
sync -f .
mv -T -- "$staging/cells.toml" cells.toml
sync -f .
`;

const checkInstalledConfig = `${verifyInstallation}
staging=$(mktemp -d .check.XXXXXXXX)
trap 'rm -rf -- "$staging"' EXIT
cat > "$staging/cells.toml"
chmod 0600 "$staging/cells.toml"
./cells --check-config "$staging/cells.toml" >/dev/null 2>&1 ||
    { echo CELLS_CONFIG_INVALID >&2; exit 1; }
`;

function checkedHash(output) {
    const hash = output.split(/\s+/, 1)[0];
    if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('CELLS_INSTALL_DIGEST_INVALID');
    return hash;
}

const configLimit = 1024 * 1024;
const readInstalledConfig = `${verifyInstallation}
head -c ${configLimit + 1} -- cells.toml | base64 -w0
`;

async function configSnapshot(run, args) {
    const encoded = await run(args, undefined, 4 * Math.ceil((configLimit + 1) / 3) + 4096);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > configLimit || bytes.toString('base64') !== encoded)
        throw fail('CELLS_CONFIG_INSTALLED_INVALID');
    return bytes;
}

export function serviceStorage(run, directory = '/usr/local/lib/nestos/cells') {
    const shell = script => ['sh', '-ec', script, 'cells-install', directory];
    return {
        installedHash: async () => checkedHash(await run(shell(verifyInstallation + '\nsha256sum cells'))),
        readConfiguration: () => configSnapshot(run, shell(readInstalledConfig)),
        configHash: async () => checkedHash(await run(shell(verifyInstallation + '\nsha256sum cells.toml'))),
        checkConfiguration: async config => {
            await run(shell(checkInstalledConfig), config);
        },
        installConfig: async (binaryHash, request, config) => {
            await run([...shell(installConfigOnly), request.operationId, binaryHash,
                request.configSha256, request.expectedConfigSha256], config);
        },
        install: async (artifact, request, config) => {
            if (config) {
                const binary = await readFile(artifact.binary);
                await run([...shell(installRelease), request.operationId, artifact.value.sha256,
                    request.configSha256, request.expectedConfigSha256, String(binary.length)], Buffer.concat([binary, config]));
                return;
            }
            await run([...shell(installBinary), request.operationId, artifact.value.sha256],
                await readFile(artifact.binary));
        },
    };
}

export function guestStorage(options) {
    return {...serviceStorage((args, input, maxBuffer) => guestCommand(options, args, input, maxBuffer)),
        waitForRestart: waitForManagedRestart};
}

export async function waitForManagedRestart(observe, windowMs = 25_000, intervalMs = 1_000) {
    const deadline = performance.now() + windowMs;
    while (true) {
        const result = await observe();
        if (result.state !== 'running') return result;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return result;
        await delay(Math.min(intervalMs, remaining));
    }
}

export async function readConfiguration(source, {privateFile = true} = {}) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw fail('CELLS_CONFIG_SOURCE_REQUIRED');
    let file;
    try {
        file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await file.stat();
        if (!metadata.isFile() || (privateFile && (metadata.mode & 0o077)) || metadata.size === 0 || metadata.size > 1024 * 1024)
            throw fail('CELLS_CONFIG_SOURCE_INVALID');
        const bytes = await file.readFile();
        if (bytes.length !== metadata.size) throw fail('CELLS_CONFIG_SOURCE_CHANGED');
        return bytes;
    } catch (error) {
        if (error.code?.startsWith('CELLS_CONFIG_')) throw error;
        throw fail('CELLS_CONFIG_SOURCE_UNAVAILABLE');
    } finally {
        await file?.close();
    }
}
