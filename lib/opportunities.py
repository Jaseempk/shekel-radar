"""Durable qualification state, sharing the SQLite schema with the Node radars."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


def now():
    return datetime.now(timezone.utc).isoformat()


class QualificationStore:
    def __init__(self, file):
        file = Path(file)
        file.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(file, timeout=5)
        file.chmod(0o600)
        self.db.executescript(Path(__file__).with_suffix('.sql').read_text())

    def ingest(self, namespace, records):
        with self.db:
            for record in records:
                if not record.get('url'):
                    raise ValueError('Lead requires a source URL')
                self.db.execute("INSERT OR IGNORE INTO opportunities(namespace,id,payload,status,collected_at) VALUES(?,?,?,'pending',?)",
                                (namespace, record['url'], json.dumps(record), now()))

    def import_legacy(self, namespace, file):
        file = Path(file)
        key = f'checkpoint:{namespace}:{file.resolve()}'
        if not file.exists() or self.db.execute('SELECT 1 FROM migrations WHERE name=?', (key,)).fetchone():
            return
        # Parse before mutating. A corrupt checkpoint needs explicit repair.
        records = [json.loads(line) for line in file.read_text().splitlines() if line.strip()]
        self.ingest(namespace, records)
        with self.db:
            for record in records:
                failed = str(record.get('buyer_reason', '')).startswith('error:')
                if not failed:
                    validate_reddit(record)
                    self.db.execute("UPDATE opportunities SET status='complete',result=?,completed_at=? WHERE namespace=? AND id=? AND status='pending'",
                                    (json.dumps(record), now(), namespace, record['url']))
            self.db.execute('INSERT INTO migrations(name) VALUES(?)', (key,))

    def pending(self, namespace):
        return [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM opportunities WHERE namespace=? AND status IN ('pending','retry') ORDER BY collected_at,id", (namespace,))]

    def complete(self, namespace, record):
        validate_reddit(record)
        with self.db:
            self.db.execute("UPDATE opportunities SET status='complete',result=?,completed_at=?,error=NULL,attempts=attempts+1 WHERE namespace=? AND id=? AND status IN ('pending','retry')",
                            (json.dumps(record), now(), namespace, record['url']))

    def fail(self, namespace, record, error):
        with self.db:
            self.db.execute("UPDATE opportunities SET status='retry',error=?,attempts=attempts+1 WHERE namespace=? AND id=? AND status IN ('pending','retry')",
                            (str(error)[:300], namespace, record['url']))

    def results(self, namespace):
        return [json.loads(row[0]) for row in self.db.execute("SELECT result FROM opportunities WHERE namespace=? AND status='complete' ORDER BY completed_at,id", (namespace,))]

    def close(self):
        self.db.close()


def validate_reddit(record):
    if type(record.get('is_buyer')) is not bool or type(record.get('buyer_score')) is not int or not 0 <= record['buyer_score'] <= 100:
        raise ValueError('Invalid Reddit qualification boolean/score')
    if not isinstance(record.get('buyer_reason'), str) or not isinstance(record.get('draft'), str):
        raise ValueError('Invalid Reddit qualification reason/draft')
    if record['is_buyer'] and not record['draft'].strip():
        raise ValueError('Qualified buyer has no draft')
