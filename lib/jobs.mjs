import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Current successful board observations are independent of notification history. */
export class JobStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS job_boards (id TEXT PRIMARY KEY, company TEXT NOT NULL, roles TEXT, observed_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS job_notifications (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS job_legacy_keys (id TEXT PRIMARY KEY);
    `);
  }
  record(company, roles, error = null) {
    const id = `${company.ats}:${company.slug}`;
    if (error) {
      this.db.prepare('INSERT INTO job_boards(id,company,error) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET error=excluded.error').run(id, company.name, String(error));
    } else {
      this.db.prepare('INSERT INTO job_boards(id,company,roles,observed_at,error) VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET company=excluded.company,roles=excluded.roles,observed_at=excluded.observed_at,error=NULL')
        .run(id, company.name, JSON.stringify(roles), new Date().toISOString());
    }
  }
  snapshot(companies) {
    const active = new Set(companies.map(c => `${c.ats}:${c.slug}`));
    const boards = this.db.prepare('SELECT * FROM job_boards').all().filter(b => active.has(b.id));
    return { rows: boards.flatMap(b => b.roles ? JSON.parse(b.roles).map(r => ({ ...r, company: b.company, observedAt: b.observed_at, collectionStatus: b.error ? 'stale' : 'ok' })) : []),
      errors: boards.filter(b => b.error).map(b => ({ company: b.company, error: b.error, lastSuccess: b.observed_at })) };
  }
  importLegacy(rows, legacy) {
    const consumed = new Set(this.db.prepare('SELECT id FROM job_legacy_keys').all().map(r => r.id));
    const matches = rows.filter(r => {
      const key = `${r.company}::${r.title}::${r.location || ''}`;
      return legacy.has(key) && !consumed.has(key);
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertId = this.db.prepare('INSERT OR IGNORE INTO job_notifications(id) VALUES(?)');
      const insertKey = this.db.prepare('INSERT OR IGNORE INTO job_legacy_keys(id) VALUES(?)');
      for (const r of matches) {
        insertId.run(r.id); insertKey.run(`${r.company}::${r.title}::${r.location || ''}`);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  unseen(rows) {
    const has = this.db.prepare('SELECT 1 FROM job_notifications WHERE id=?');
    return rows.filter(r => !has.get(r.id));
  }
  notified(rows) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO job_notifications(id) VALUES(?)');
      rows.forEach(r => insert.run(r.id)); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
