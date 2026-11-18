import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as pause} from 'node:timers/promises';

export const physicalSeqSchema = 'CREATE TABLE entries(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)';

function database(file, readOnly = false) {
    const db = new DatabaseSync(file, {readOnly});
    try {
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
        return db;
    } catch (error) {db.close(); throw error;}
}

function rollback(db) {
    try {db.exec('ROLLBACK');}
    catch (error) {if (!String(error.message).includes('no transaction is active')) throw error;}
}

async function retryBusy(operation) {
    const deadline = performance.now() + 5000;
    for (;;) {
        try {return operation();}
        catch (error) {
            if ((error.errcode & 255) !== 5 || performance.now() >= deadline) throw error;
            await pause(10);
        }
    }
}

const put = 'INSERT INTO entries(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value';
function change(db,key,value) {
    if (value === null) db.prepare('DELETE FROM entries WHERE key=?').run(key);
    else db.prepare(put).run(key,value);
}

// The resolver belongs to the host. Callers supply logical names, never SQLite paths.
class FileSet {
    #writers = new Map();
    #readers = new Map();
    #closed = false;
    constructor(resolve, journal) {this.resolve = resolve; this.journal = journal;}
    #file(name,write = false) {
        if (this.#closed) throw new Error('SEQ_TRANSACTION_CLOSED');
        if (this.#writers.has(name)) return this.#writers.get(name);
        if (!write && this.#readers.has(name)) return this.#readers.get(name);
        const db = database(this.resolve(name),!write);
        if (write) {
            this.#writers.set(name,db);
            db.exec('BEGIN IMMEDIATE');
        } else {
            if (this.#readers.size >= 64) {
                const oldest = this.#readers.keys().next().value;
                this.#readers.get(oldest).close(); this.#readers.delete(oldest);
            }
            this.#readers.set(name,db);
        }
        return db;
    }
    get(name,key) {
        const row = this.#file(name).prepare('SELECT value FROM entries WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : undefined;
    }
    getMany(name,keys) {
        if (!keys.length) return [];
        const db = this.#file(name), values = new Map();
        for (let index = 0; index < keys.length; index += 200) {
            const batch = keys.slice(index,index+200);
            const query = db.prepare('SELECT key,value FROM entries WHERE key IN ('+batch.map(() => '?').join(',')+')');
            for (const row of query.all(...batch)) values.set(row.key,JSON.parse(row.value));
        }
        return keys.map(key => values.get(key));
    }
    page(name,{lower,upper,after,limit,offset = 0,keysOnly = false}) {
        if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) {
            throw new RangeError('SEQ_PAGE_BOUNDS');
        }
        const db = this.#file(name), conditions = ['key >= ?'], values = [lower];
        if (upper != null) {conditions.push('key < ?');values.push(upper);}
        if (after != null) {conditions.push('key > ?');values.push(after);}
        const where = ' FROM entries WHERE '+conditions.join(' AND ');
        const selection = keysOnly ? 'key' : 'key,value';
        const rows = db.prepare('SELECT '+selection+where+' ORDER BY key LIMIT ? OFFSET ?').all(...values,limit,offset);
        return keysOnly ? rows.map(row => row.key) : rows.map(row => ({key:row.key,value:JSON.parse(row.value)}));
    }
    set(name,key,value) {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new TypeError('SEQ_VALUE_REQUIRED');
        this.#change(name,key,encoded);
    }
    delete(name,key) {this.#change(name,key,null);}
    #change(name,key,value) {
        if (!this.journal) throw new Error('SEQ_READ_ONLY');
        change(this.#file(name,true),key,value);
        this.journal.run(name,key,value);
    }
    close() {
        this.#closed = true;
        for (const group of [this.#writers,this.#readers]) {
            for (const db of group.values()) db.close();
            group.clear();
        }
    }
}

const pending = 'SELECT id FROM publication';
const journal = 'INSERT INTO changes(file,key,value) VALUES(?,?,?)';

// Use the rollback-mode coordinator as a shared snapshot lock. File count is independent of ATTACH.
export class PhysicalSeqTransactions {
    #queue = Promise.resolve();
    #db;
    constructor(file,resolve) {
        this.resolve = resolve;
        this.#db = database(file);
        try {
            const mode = this.#db.prepare('PRAGMA journal_mode').get().journal_mode;
            if (mode !== 'delete') throw new Error('SEQ_COORDINATOR_MODE');
            this.#db.exec('CREATE TABLE IF NOT EXISTS publication(id TEXT PRIMARY KEY);' +
                'CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY,file TEXT NOT NULL,key TEXT NOT NULL,value TEXT);' +
                'CREATE INDEX IF NOT EXISTS changes_file_sequence ON changes(file,sequence)');
        } catch (error) {this.#db.close(); throw error;}
    }
    #enqueue(operation) {
        const run = this.#queue.then(operation);
        this.#queue = run.catch(() => {});
        return run;
    }
    read(operation) {return this.#enqueue(() => this.#run(false,operation));}
    write(operation) {return this.#enqueue(() => this.#run(true,operation));}
    close() {return this.#enqueue(() => this.#db.close());}

    async #begin(write) {
        for (;;) {
            const outstanding = await retryBusy(() => {
                this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
                try {return this.#db.prepare(pending).get();}
                catch (error) {rollback(this.#db); throw error;}
            });
            if (!outstanding) return;
            rollback(this.#db);
            await this.#publish();
        }
    }
    async #run(write,operation) {
        await this.#begin(write);
        const files = new FileSet(this.resolve,write ? this.#db.prepare(journal) : undefined);
        try {
            let result;
            if (!write) this.#db.exec('PRAGMA query_only=ON');
            try {result = await operation(files,this.#db);}
            finally {
                files.close();
                if (!write) this.#db.exec('PRAGMA query_only=OFF');
            }
            const changed = write && this.#db.prepare('SELECT 1 FROM changes LIMIT 1').get();
            if (changed) this.#db.prepare('INSERT INTO publication VALUES(?)').run(randomUUID());
            await retryBusy(() => this.#db.exec('COMMIT'));
            if (changed) {
                try {await this.#publish();}
                catch (cause) {throw Object.assign(new Error('SEQ_PUBLICATION_PENDING',{cause}),{committed:true});}
            }
            return result;
        } catch (error) {rollback(this.#db); throw error;}
    }
    async #publish() {
        await retryBusy(() => this.#db.exec('BEGIN EXCLUSIVE'));
        try {
            const batch = this.#db.prepare(pending).get();
            if (batch) {
                const groups = this.#db.prepare('SELECT DISTINCT file FROM changes').all();
                for (const {file} of groups) this.#apply(file,batch.id);
                this.#db.exec('DELETE FROM changes; DELETE FROM publication');
            }
            this.#db.exec('COMMIT');
        } catch (error) {rollback(this.#db); throw error;}
    }
    #apply(file,id) {
        const db = database(this.resolve(file));
        try {
            db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS seq_publication(slot INTEGER PRIMARY KEY,id TEXT NOT NULL)');
            if (db.prepare('SELECT id FROM seq_publication WHERE slot=1').get()?.id !== id) {
                const rows = this.#db.prepare('SELECT key,value FROM changes WHERE file=? ORDER BY sequence').iterate(file);
                for (const row of rows) change(db,row.key,row.value);
                db.prepare('INSERT OR REPLACE INTO seq_publication VALUES(1,?)').run(id);
            }
            db.exec('COMMIT');
        } finally {db.close();}
    }
}
