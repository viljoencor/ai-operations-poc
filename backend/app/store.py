"""Local SQLite durable investigation and audit state (demo only)."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS investigations (
                    id TEXT PRIMARY KEY,
                    booking_id TEXT NOT NULL,
                    requested_by TEXT NOT NULL,
                    question TEXT NOT NULL,
                    planner TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    snapshot TEXT NOT NULL,
                    approved_by TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    investigation_id TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    FOREIGN KEY(investigation_id) REFERENCES investigations(id)
                );
            """)

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def create(self, booking_id, requester, question, planner):
        investigation_id = f"INV-{uuid4().hex[:10].upper()}"
        now = utc_now()
        with self._db() as db:
            db.execute("""INSERT INTO investigations
                (id, booking_id, requested_by, question, planner, status, summary, reason, snapshot, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'INVESTIGATING', '', '', '{}', ?, ?)""",
                (investigation_id, booking_id, requester, question, planner, now, now))
        self.event(investigation_id, requester, "INVESTIGATION_STARTED", f"Read-only runbook for {booking_id}")
        return investigation_id

    def event(self, investigation_id, actor, action, detail):
        with self._db() as db:
            db.execute("INSERT INTO audit_events (investigation_id, occurred_at, actor, action, detail) VALUES (?, ?, ?, ?, ?)",
                       (investigation_id, utc_now(), actor, action, detail))

    def finish(self, investigation_id, status, summary, reason, snapshot):
        with self._db() as db:
            db.execute("UPDATE investigations SET status=?, summary=?, reason=?, snapshot=?, updated_at=? WHERE id=?",
                       (status, summary, reason, json.dumps(snapshot), utc_now(), investigation_id))
        self.event(investigation_id, "orchestrator", "EVALUATION_COMPLETED", f"Status: {status}")

    def get(self, investigation_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM investigations WHERE id=?", (investigation_id,)).fetchone()
            if row is None:
                return None
            events = db.execute("SELECT occurred_at, actor, action, detail FROM audit_events WHERE investigation_id=? ORDER BY id",
                                (investigation_id,)).fetchall()
        record = dict(row)
        record["snapshot"] = json.loads(record["snapshot"])
        record["events"] = [dict(event) for event in events]
        return record

    def list_recent(self):
        with self._db() as db:
            rows = db.execute("SELECT id, booking_id, requested_by, status, summary, created_at FROM investigations ORDER BY created_at DESC LIMIT 40").fetchall()
        return [dict(row) for row in rows]

    def claim_approval(self, investigation_id, approved_by):
        """Atomically grant a single executor the right to make the system call."""
        db = self._db()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status, requested_by FROM investigations WHERE id=?", (investigation_id,)).fetchone()
            if row is None:
                db.rollback()
                return "not_found"
            if row["requested_by"].casefold() == approved_by.casefold():
                db.rollback()
                return "same_actor"
            if row["status"] != "AWAITING_APPROVAL":
                db.rollback()
                return "invalid_state"
            db.execute("UPDATE investigations SET status='EXECUTING', approved_by=?, updated_at=? WHERE id=?",
                       (approved_by, utc_now(), investigation_id))
            db.commit()
            return "ok"
        finally:
            db.close()

    def replace_snapshot(self, investigation_id, snapshot):
        with self._db() as db:
            db.execute("UPDATE investigations SET snapshot=?, updated_at=? WHERE id=?",
                       (json.dumps(snapshot), utc_now(), investigation_id))

    def set_status(self, investigation_id, status, reason):
        with self._db() as db:
            db.execute("UPDATE investigations SET status=?, reason=?, updated_at=? WHERE id=?",
                       (status, reason, utc_now(), investigation_id))
