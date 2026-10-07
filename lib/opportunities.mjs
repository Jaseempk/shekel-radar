import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateVerdicts } from './qualification.mjs';

/** SQLite is the authority; exports are disposable views. Namespace includes source + search pack. */
export class OpportunityStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(fs.readFileSync(new URL('./opportunities.sql', import.meta.url), 'utf8'));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  importLegacy(namespace, file) {
    if (!file || !fs.existsSync(file)) return;
    const name = `seen:${namespace}:${file}`;
    if (this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get(name)) return;
    const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(ids)) throw new Error('Legacy seen state must be an array');
    this.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO opportunities(namespace,id,payload,status,collected_at) VALUES(?,?,?,'legacy',?)");
      for (const id of ids) insert.run(namespace, String(id), '{}', new Date().toISOString());
      this.db.prepare('INSERT INTO migrations(name) VALUES(?)').run(name);
    });
  }
  ingest(namespace, records, skip = () => false) {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO opportunities(namespace,id,payload,status,collected_at) VALUES(?,?,?,?,?)');
      for (const record of records) {
        if (!record.id || typeof record.text !== 'string') throw new Error('Source record requires id and text');
        insert.run(namespace, String(record.id), JSON.stringify(record), skip(record) ? 'skipped' : 'pending', new Date().toISOString());
      }
    });
  }
  pending(namespace) {
    return this.db.prepare("SELECT payload FROM opportunities WHERE namespace=? AND status IN ('pending','retry') ORDER BY collected_at,id")
      .all(namespace).map(r => JSON.parse(r.payload));
  }
  complete(namespace, batch, verdicts, options = {}) {
    const validated = validateVerdicts(verdicts, batch.length, options);
    const now = new Date().toISOString();
    this.transaction(() => {
      const update = this.db.prepare("UPDATE opportunities SET status='complete',result=?,error=NULL,attempts=attempts+1,completed_at=? WHERE namespace=? AND id=? AND status IN ('pending','retry')");
      for (const v of validated) {
        const { i, ...outcome } = v;
        update.run(JSON.stringify({ ...batch[i], ...outcome }), now, namespace, String(batch[i].id));
      }
    });
  }
  fail(namespace, batch, error) {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE opportunities SET status='retry',error=?,attempts=attempts+1 WHERE namespace=? AND id=? AND status IN ('pending','retry')");
      for (const record of batch) update.run(String(error.message ?? error).slice(0, 300), namespace, String(record.id));
    });
  }
  results(namespace, day) {
    return this.db.prepare("SELECT result FROM opportunities WHERE namespace=? AND status='complete' AND substr(completed_at,1,10)=? ORDER BY completed_at,id")
      .all(namespace, day).map(r => JSON.parse(r.result));
  }
  close() { this.db.close(); }
}

export async function qualifyPending(store, namespace, score, options = {}) {
  const pending = store.pending(namespace);
  let failures = 0;
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { store.complete(namespace, batch, await score(batch), options); break; }
      catch (e) {
        store.fail(namespace, batch, e);
        console.error(`Qualification attempt ${attempt}/2 failed: ${e.message}`);
        if (attempt === 2) failures += batch.length;
      }
    }
  }
  return failures;
}
