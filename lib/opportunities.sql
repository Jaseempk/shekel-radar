PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS opportunities (
  namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY(namespace, id)
);
CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
