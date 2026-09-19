"""Small, durable, single-instance job ledger. No imagery or user secrets in logs."""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def data_directory() -> Path:
    directory = Path(os.getenv("ANALYSIS_DATA_DIR", "./data/analysis"))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory


def connection():
    db = sqlite3.connect(data_directory() / "runs.sqlite3", timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, cache_key TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        request TEXT NOT NULL, result TEXT, error TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS runs_owner_cache ON runs(owner, cache_key)")
    return db


def now():
    return datetime.now(timezone.utc).isoformat()


def recover_interrupted():
    with connection() as db:
        db.execute("UPDATE runs SET status='FAILED', error=?, updated_at=? WHERE status NOT IN ('COMPLETE','FAILED')",
                   ("The API restarted during processing. Submit the analysis again.", now()))


def create_run(run_id: str, owner: str, cache_key: str, request: dict):
    with connection() as db:
        active = db.execute("SELECT count(*) FROM runs WHERE status NOT IN ('COMPLETE','FAILED')").fetchone()[0]
        if active >= 12:
            raise ValueError("The processing queue is full. Try again after a running job completes.")
        db.execute("INSERT INTO runs VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, NULL, NULL)",
                   (run_id, owner, cache_key, now(), now(), json.dumps(request, allow_nan=False)))


def update_run(run_id: str, status: str, result=None, error=None):
    with connection() as db:
        db.execute("UPDATE runs SET status=?, updated_at=?, result=COALESCE(?, result), error=? WHERE id=?",
                   (status, now(), json.dumps(result, allow_nan=False) if result is not None else None, error, run_id))


def get_run(run_id: str):
    with connection() as db:
        row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        return None
    result = dict(row)
    result["request"] = json.loads(result["request"])
    result["result"] = json.loads(result["result"]) if result["result"] else None
    return result


def cached_run(owner: str, cache_key: str):
    with connection() as db:
        row = db.execute("SELECT id FROM runs WHERE owner=? AND cache_key=? AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1",
                         (owner, cache_key)).fetchone()
    return get_run(row[0]) if row else None
