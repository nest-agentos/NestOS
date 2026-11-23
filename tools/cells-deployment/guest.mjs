import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {fail} from './artifact.mjs';

const exec = promisify(execFile);
export const installedExecutable = '/usr/local/lib/nestos/cells/cells';
export const installedConfig = '/usr/local/lib/nestos/cells/cells.toml';

export async function command(file, args, timeout = 15000, input) {
    try {
        const result = exec(file, args, {timeout, maxBuffer: 262144, killSignal: 'SIGKILL'});
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

async function guestCommand(options, args, input) {
    const address = await command('sudo', ['-n', options.server, 'network', 'address', options.vm]);
    const [ip, alias] = address.split(/\s+/);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^nestos-[\w-]+$/.test(alias)) throw fail('SERVICE_ADDRESS_INVALID');
    return command('sudo', ['-n', 'ssh', '-F', '/dev/null', '-T', '-i', options.identity,
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=/var/lib/nestos-firecracker/services/known_hosts',
        '-o', 'HostKeyAlias=' + alias, 'agent@' + ip, args.map(quote).join(' ')], 120000, input);
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
            rows.append(hashlib.file_digest(binary, 'sha256').hexdigest())
    except OSError:
        pass
if len(rows) != 1:
    sys.exit('CELLS_INSTALL_PROCESS_UNVERIFIED')
print(rows[0])
`;

export async function runningHash(options) {
    const args = ['python3', '-c', hashProcess, options.executable];
    if (options.executable === installedExecutable) args.push(installedConfig);
    return checkedHash(await guestCommand(options, args));
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

function checkedHash(output) {
    const hash = output.split(/\s+/, 1)[0];
    if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('CELLS_INSTALL_DIGEST_INVALID');
    return hash;
}

export function serviceStorage(run, directory = '/usr/local/lib/nestos/cells') {
    const shell = script => ['sh', '-ec', script, 'cells-install', directory];
    return {
        installedHash: async () => checkedHash(await run(shell(verifyInstallation + '\nsha256sum cells'))),
        install: async (artifact, request) => {
            await run([...shell(installBinary), request.operationId, artifact.value.sha256],
                await readFile(artifact.binary));
        },
    };
}

export function guestStorage(options) {
    return serviceStorage((args, input) => guestCommand(options, args, input));
}
