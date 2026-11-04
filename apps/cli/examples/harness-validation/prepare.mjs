import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Require a fresh destination so an existing profile is never overwritten.
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node prepare.mjs <new-directory>');
const root = path.resolve(destination), source = path.dirname(fileURLToPath(import.meta.url));
await mkdir(root);
const profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace');
for (const dir of ['home/admin/flows', 'etc/llm/.skills', 'etc/llm/.mcp']) await mkdir(path.join(profile, dir), { recursive: true });
await mkdir(workspace);
for (const name of ['harness-tools', 'harness-skill', 'harness-mcp', 'harness-combined']) {
    await copyFile(path.join(source, `${name}.flow`), path.join(profile, 'home/admin/flows', `${name}.flow`));
}
await copyFile(path.join(source, 'workspace/notes.txt'), path.join(workspace, 'notes.txt'));
await copyFile(path.join(source, 'validation-review.yaml'), path.join(profile, 'etc/llm/.skills/validation-review.yaml'));
await copyFile(path.join(source, 'mcp-server.mjs'), path.join(root, 'mcp-server.mjs'));
await writeFile(path.join(profile, 'etc/llm/.mcp/validation.json'), JSON.stringify({ id: 'validation', name: 'Harness Validation',
    transport: 'stdio', command: process.execPath, args: JSON.stringify([path.join(root, 'mcp-server.mjs'), path.join(root, 'mcp-calls.jsonl')]) }, null, 2));
process.stdout.write(JSON.stringify({ profile, workspace, connectionRequired: 'default' }, null, 2) + '\n');
