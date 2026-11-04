import { RECORD_PAGE_SQL, recordPageValues, decodeRecordPage, type RecordPageRow } from '@itookit/vfsdriver-local';
/**
 * @file apps/tauri-app/src/db/tauri-sql-sidecar.ts
 *
 * TauriSqlSidecarDb — ISidecarDb backed by the Tauri host's SQLite pools.
 *
 * v4.1: Path-based schema — aligns with BetterSqliteSidecarDb.
 *   - meta_ext keyed by path (TEXT), no ino allocation
 *   - meta_tags references meta_ext(path) ON DELETE CASCADE
 *   - Only stores non-derivable metadata (tags, icon, device_handler, etc.)
 *
 * Transactions use a Rust-owned SQLx transaction; plugin-sql calls alone do not
 * preserve connection affinity across statements.
 */

import { invoke } from '@tauri-apps/api/core';
import { PATH_DATA_EXISTS, movePathStatements, SCHEMA_VERSION } from '@itookit/vfsdriver-local';
import type { ISidecarDb, MetaExtRow } from '@itookit/vfsdriver-local';

interface SidecarConnection {
    execute(query: string, values?: unknown[]): Promise<unknown>;
    select<T>(query: string, values?: unknown[]): Promise<T>;
    close(): Promise<void>;
}

let pageScope: Promise<number> | undefined;

function openPageScope(): Promise<number> {
    // One handshake per JS page, before loading pools from the previous page.
    return pageScope ??= invoke<number>('sidecar_open_scope').catch(error => {
        pageScope = undefined;
        throw error;
    });
}

function openConnection(database: string, scope: number): SidecarConnection {
    return {
        execute: (query, values) => invoke('sidecar_database_execute', {
            database, scope, query, values: values ?? [],
        }),
        select: (query, values) => invoke('sidecar_database_select', {
            database, scope, query, values: values ?? [],
        }),
        close: () => invoke('sidecar_close_database', { database, scope }).then(() => undefined),
    };
}

// ── Path-based DDL — one statement per execute() ──────────────────────────────

const DDL_STATEMENTS = [
    // PRAGMAs via select() (they return rows)
    'PRAGMA journal_mode = WAL',
    'PRAGMA busy_timeout = 30000',
    'PRAGMA foreign_keys = ON',

    // Schema version
    'CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY)',

    // Non-derivable metadata keyed by relative path
    `CREATE TABLE IF NOT EXISTS meta_ext (
        path            TEXT PRIMARY KEY,
        icon            TEXT,
        device_handler  TEXT,
        is_asset_dir    INTEGER NOT NULL DEFAULT 0,
        tags            TEXT,
        metadata        TEXT,
        extra           TEXT
    )`,

    // Materialised tag index — FK to meta_ext
    `CREATE TABLE IF NOT EXISTS meta_tags (
        path TEXT NOT NULL REFERENCES meta_ext(path) ON DELETE CASCADE,
        tag  TEXT NOT NULL,
        PRIMARY KEY (path, tag)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_meta_tags_tag ON meta_tags(tag)',

    `CREATE TABLE IF NOT EXISTS records (
        path TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (path, field)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_records_path ON records(path, field)',

];
const SCHEMA_OBJECTS = ['_schema_version', 'meta_ext', 'meta_tags', 'records', 'idx_meta_tags_tag', 'idx_records_path'];

export class TauriSqlSidecarDb implements ISidecarDb {
    private constructor(private readonly db: SidecarConnection, private readonly databaseUrl?: string, private readonly scope?: number) {}

    // ── Factory ────────────────────────────────────────────────────────────────

    static async open(dbPath: string): Promise<TauriSqlSidecarDb> {
        const scope = await openPageScope();
        const database = `sqlite:${dbPath}`;
        await invoke('sidecar_open_database', { database, scope });
        const instance = new TauriSqlSidecarDb(openConnection(database, scope), database, scope);
        try {
            const initialized = await instance.assertSchemaVersion();
            await instance.initSchema(initialized);
            return instance;
        } catch (error) {
            try { await instance.close(); } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Sidecar initialization and cleanup failed', { cause: error });
            }
            throw error;
        }
    }

    // ── Schema migration ───────────────────────────────────────────────────────

    private async assertSchemaVersion(): Promise<boolean> {
        const tables = await this.db.select<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'");
        if (!tables.length) return false;
        const versions = tables.some(table => table.name === '_schema_version')
            ? await this.db.select<Array<{ version: number }>>('SELECT version FROM _schema_version') : [];
        if (versions.length !== 1 || versions[0].version !== SCHEMA_VERSION) throw new Error('Filesystem database version incompatible');
        return SCHEMA_OBJECTS.every(name => tables.some(table => table.name === name));
    }

    // ── Schema ─────────────────────────────────────────────────────────────────

    private async initSchema(initialized: boolean): Promise<void> {
        for (const stmt of initialized ? DDL_STATEMENTS.filter(sql => sql.startsWith('PRAGMA')) : DDL_STATEMENTS) {
            // PRAGMAs return rows → use select(); DDL → use execute()
            if (stmt.startsWith('PRAGMA')) {
                await this.db.select(stmt);
            } else {
                await this.db.execute(stmt);
            }
        }
        if (initialized) return;

        // Version stamp
        const rows = await this.db.select<Array<{ version: number }>>(
            'SELECT version FROM _schema_version WHERE version = ?',
            [SCHEMA_VERSION],
        );
        if (rows.length === 0) {
            await this.db.execute(
                'INSERT OR REPLACE INTO _schema_version (version) VALUES (?)',
                [SCHEMA_VERSION],
            );
        }
    }

    // ── meta_ext (path-based) ──────────────────────────────────────────────────

    async getMetaExt(path: string): Promise<MetaExtRow | null> {
        const rows = await this.db.select<MetaExtRow[]>(
            'SELECT * FROM meta_ext WHERE path = ?',
            [path],
        );
        return rows[0] ?? null;
    }

    async getMetaExtMany(paths: string[]): Promise<MetaExtRow[]> {
        const unique = [...new Set(paths)];
        if (!unique.length) return [];
        return this.db.select<MetaExtRow[]>(
            `SELECT * FROM meta_ext WHERE path IN (${unique.map(() => '?').join(', ')})`, unique,
        );
    }

    async upsertMetaExt(row: MetaExtRow): Promise<void> {
        await this.db.execute(
            `INSERT INTO meta_ext (path, icon, device_handler, is_asset_dir, tags, metadata, extra)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
                icon = excluded.icon, device_handler = excluded.device_handler,
                is_asset_dir = excluded.is_asset_dir, tags = excluded.tags,
                metadata = excluded.metadata, extra = excluded.extra`,
            [
                row.path, row.icon, row.device_handler, row.is_asset_dir,
                row.tags, row.metadata, row.extra,
            ],
        );
    }

    async deleteMetaExt(path: string): Promise<void> {
        await this.db.execute("DELETE FROM meta_ext WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'", [path, path, path]);
    }

    // ── tags ───────────────────────────────────────────────────────────────────

    async syncTags(path: string, tags: string[] | undefined): Promise<void> {
        // Ensure meta_ext row exists (foreign_keys = ON requires it)
        await this.db.execute(
            `INSERT OR IGNORE INTO meta_ext (path, is_asset_dir) VALUES (?, 0)`,
            [path],
        );
        await this.db.execute('DELETE FROM meta_tags WHERE path = ?', [path]);
        if (tags) {
            for (const tag of tags) {
                await this.db.execute(
                    'INSERT OR IGNORE INTO meta_tags (path, tag) VALUES (?, ?)',
                    [path, tag],
                );
            }
        }
    }

    async getAllDistinctTags(): Promise<string[]> {
        const rows = await this.db.select<Array<{ tag: string }>>(
            'SELECT DISTINCT tag FROM meta_tags ORDER BY tag',
        );
        return rows.map(r => r.tag);
    }

    async listTagEntries(): Promise<Array<{ path: string; tag: string }>> {
        return this.db.select<Array<{ path: string; tag: string }>>('SELECT path, tag FROM meta_tags ORDER BY path, tag');
    }

    async queryByTag(tag: string): Promise<string[]> {
        const rows = await this.db.select<Array<{ path: string }>>(
            'SELECT path FROM meta_tags WHERE tag = ?',
            [tag],
        );
        return rows.map(r => r.path);
    }

    async queryByMetadata(jsonPath: string, value: string): Promise<string[]> {
        const rows = await this.db.select<Array<{ path: string }>>(
            'SELECT path FROM meta_ext WHERE json_extract(metadata, ?) = ?',
            [jsonPath, value],
        );
        return rows.map(r => r.path);
    }

    async getRecordField(path: string, field: string): Promise<unknown | undefined> {
        const rows = await this.db.select<Array<{ value: string }>>(
            'SELECT value FROM records WHERE path = ? AND field = ?', [path, field],
        );
        return rows[0] ? JSON.parse(rows[0].value) : undefined;
    }

    async getRecordFields(path: string, fields: string[]): Promise<Record<string, unknown>> {
        const unique = [...new Set(fields)];
        const result: Record<string, unknown> = {};
        for (let start = 0; start < unique.length; start += 512) {
            const batch = unique.slice(start, start + 512);
            const rows = await this.db.select<Array<{ field: string; value: string }>>(
                `SELECT field, value FROM records WHERE path = ? AND field IN (${batch.map(() => '?').join(', ')})`,
                [path, ...batch],
            );
            for (const row of rows) result[row.field] = JSON.parse(row.value);
        }
        return result;
    }

    /** Requests are pre-batched by the caller (SidecarRecordStore) to stay under the parameter limit. */
    async getRecordFieldsMany(requests: ReadonlyArray<{ path: string; field: string }>): Promise<Array<unknown | undefined>> {
        if (!requests.length) return [];
        const rows = await this.db.select<Array<{ path: string; field: string; value: string }>>(
            `SELECT path, field, value FROM records WHERE (path, field) IN (${requests.map(() => '(?, ?)').join(', ')})`,
            requests.flatMap(request => [request.path, request.field]),
        );
        const found = new Map(rows.map(row => [`${row.path}\u0000${row.field}`, JSON.parse(row.value) as unknown]));
        return requests.map(request => found.get(`${request.path}\u0000${request.field}`));
    }

    async setRecordField(path: string, field: string, value: unknown): Promise<void> {
        await this.db.execute(
            `INSERT INTO records(path, field, value) VALUES (?, ?, ?)
             ON CONFLICT(path, field) DO UPDATE SET value = excluded.value`,
            [path, field, JSON.stringify(value)],
        );
    }

    async deleteRecordField(path: string, field: string): Promise<void> {
        await this.db.execute('DELETE FROM records WHERE path = ? AND field = ?', [path, field]);
    }

    async listRecordFields(path: string, prefix = ''): Promise<Array<{ field: string; value: unknown }>> {
        const rows = await this.db.select<Array<{ field: string; value: string }>>(
            `SELECT field, value FROM records
             WHERE path = ? AND field LIKE ? ESCAPE '\\' ORDER BY field`,
            [path, `${escapeLike(prefix)}%`],
        );
        return rows.map(row => ({ field: row.field, value: JSON.parse(row.value) }));
    }

    async listRecordFieldsPage(path: string, prefix: string, offset: number, limit: number) {
        const rows = await this.db.select<RecordPageRow[]>(RECORD_PAGE_SQL, recordPageValues(path, prefix, offset, limit));
        return decodeRecordPage(rows);
    }

    async clearRecordFields(path: string): Promise<void> {
        await this.db.execute('DELETE FROM records WHERE path = ?', [path]);
    }

    // ── health ─────────────────────────────────────────────────────────────────

    async healthCheck(): Promise<{ ok: boolean; error?: string }> {
        try {
            const rows = await this.db.select<Array<{ integrity_check: string }>>(
                'PRAGMA integrity_check',
            );
            const ok = rows[0]?.integrity_check === 'ok';
            return ok ? { ok: true } : { ok: false, error: rows[0]?.integrity_check };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async assertPathDataVacant(path: string): Promise<void> {
        const rows = await this.db.select<unknown[]>(PATH_DATA_EXISTS, [path, path, path, path, path, path]);
        if (rows.length) throw new Error(`Destination has durable data: ${path}`);
    }



    async movePathData(from: string, to: string): Promise<void> {
        for (const { sql, values } of movePathStatements(from, to)) await this.db.execute(sql, values);
    }

    // ── transaction ────────────────────────────────────────────────────────────

    async transaction<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        if (!this.databaseUrl) throw new Error('Nested sidecar transactions are not supported');
        const transactionId = await invoke<number>('sidecar_begin', { database: this.databaseUrl, scope: this.scope });
        const identity = { transactionId, database: this.databaseUrl, scope: this.scope };
        const scoped = new TauriSqlSidecarDb({
            execute: (query, values) => invoke('sidecar_execute', { ...identity, query, values: values ?? [] }),
            select: (query, values) => invoke('sidecar_select', { ...identity, query, values: values ?? [] }),
            close: async () => { throw new Error('Cannot close a transaction-scoped sidecar'); },
        });
        try {
            const result = await operation(scoped);
            await invoke('sidecar_finish', { ...identity, commit: true });
            return result;
        } catch (error) {
            try { await invoke('sidecar_finish', { ...identity, commit: false }); }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], 'Sidecar transaction failed and rollback failed', { cause: error });
            }
            throw error;
        }
    }

    async begin(): Promise<void> { throw new Error('Use transaction(callback) for Tauri sidecar transactions'); }
    async commit(): Promise<void> { throw new Error('Use transaction(callback) for Tauri sidecar transactions'); }
    async rollback(): Promise<void> { throw new Error('Use transaction(callback) for Tauri sidecar transactions'); }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    async close(): Promise<void> {
        if (!this.databaseUrl) throw new Error('Cannot close an unidentified sidecar database');
        await this.db.close();
    }
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}
