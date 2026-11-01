"""Three independent simulated on-prem business system API processes.

Only the Booking System has a write endpoint, protected by idempotency and a shared
service token. Demo-only: production would require workload identity and mTLS.
"""
import hmac
import json
import os
import sqlite3
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

KIND = os.getenv("SYSTEM_KIND", "booking")
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "local-demo-service-token")
DB_PATH = os.getenv("BOOKING_DB", "/tmp/booking-system.db")
app = FastAPI(title=f"Simulated {KIND.title()} System")

SEEDS = {
    "BK-2047": ("PENDING_PROVIDER", "FAILED", "Provider gateway timeout"),
    "BK-2048": ("PENDING_PROVIDER", "FAILED", "Provider confirmation failed"),
    "BK-2049": ("CONFIRMED", "COMPLETE", "Confirmed normally"),
    "BK-2050": ("PENDING_PROVIDER", "FAILED", "Provider gateway timeout"),
}
PAYMENTS = {
    "BK-2047": ("CAPTURED", 2850), "BK-2048": ("DECLINED", 1850),
    "BK-2049": ("CAPTURED", 3200), "BK-2050": ("CAPTURED", 4100),
}
HOLDS = {
    "BK-2047": "ACTIVE", "BK-2048": "ACTIVE", "BK-2049": "CONSUMED", "BK-2050": "EXPIRED",
}


def initialise():
    if KIND != "booking":
        return
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.execute("CREATE TABLE IF NOT EXISTS bookings (booking_id TEXT PRIMARY KEY, status TEXT NOT NULL, sync_status TEXT NOT NULL, note TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, booking_id TEXT NOT NULL, response TEXT NOT NULL)")
        for booking_id, (status, sync, note) in SEEDS.items():
            db.execute("INSERT OR IGNORE INTO bookings VALUES (?, ?, ?, ?)", (booking_id, status, sync, note))


initialise()


def auth(token):
    if not hmac.compare_digest(token, SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid service identity")


def correct_kind(name):
    if KIND != name:
        raise HTTPException(status_code=404, detail="Not a service endpoint")


@app.get("/health")
async def health():
    return {"ok": True, "system": KIND}


@app.get("/bookings/{booking_id}")
async def booking(booking_id: str, x_service_token: str = Header(default="")):
    correct_kind("booking")
    auth(x_service_token)
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute("SELECT booking_id, status, sync_status, note FROM bookings WHERE booking_id=?", (booking_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Booking not found")
    return dict(zip(("booking_id", "status", "sync_status", "note"), row))


@app.get("/payments/by-booking/{booking_id}")
async def payment(booking_id: str, x_service_token: str = Header(default="")):
    correct_kind("payment")
    auth(x_service_token)
    if booking_id not in PAYMENTS:
        raise HTTPException(status_code=404, detail="Payment not found")
    status, amount = PAYMENTS[booking_id]
    return {"booking_id": booking_id, "status": status, "amount_zar": amount, "reference": "PAY-" + booking_id.removeprefix("BK-")}


@app.get("/holds/by-booking/{booking_id}")
async def inventory(booking_id: str, x_service_token: str = Header(default="")):
    correct_kind("inventory")
    auth(x_service_token)
    if booking_id not in HOLDS:
        raise HTTPException(status_code=404, detail="Inventory hold not found")
    return {"booking_id": booking_id, "hold_status": HOLDS[booking_id], "provider": "Demo Accommodation Provider"}


class RetryBody(BaseModel):
    reason: str


@app.post("/bookings/{booking_id}/retry-confirmation")
async def retry(booking_id: str, body: RetryBody, x_service_token: str = Header(default=""),
                x_idempotency_key: str = Header(default="")):
    correct_kind("booking")
    auth(x_service_token)
    if not x_idempotency_key or len(x_idempotency_key) > 100:
        raise HTTPException(status_code=422, detail="Idempotency key required")
    # The gateway is simulated. No third-party platform is ever called.
    db = sqlite3.connect(DB_PATH, timeout=10)
    try:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT booking_id, response FROM idempotency WHERE key=?", (x_idempotency_key,)).fetchone()
        if existing:
            db.rollback()
            if existing[0] != booking_id:
                raise HTTPException(status_code=409, detail="Idempotency key reused for a different booking")
            return json.loads(existing[1])
        row = db.execute("SELECT status, sync_status FROM bookings WHERE booking_id=?", (booking_id,)).fetchone()
        if not row:
            db.rollback()
            raise HTTPException(status_code=404, detail="Booking not found")
        if row != ("PENDING_PROVIDER", "FAILED"):
            db.rollback()
            raise HTTPException(status_code=409, detail="Booking is not eligible for retry")
        result = {"booking_id": booking_id, "status": "CONFIRMED", "sync_status": "COMPLETE",
                  "note": "Simulated provider confirmation after approved retry"}
        db.execute("UPDATE bookings SET status=?, sync_status=?, note=? WHERE booking_id=?",
                   (result["status"], result["sync_status"], result["note"], booking_id))
        db.execute("INSERT INTO idempotency VALUES (?, ?, ?)", (x_idempotency_key, booking_id, json.dumps(result)))
        db.commit()
        return result
    finally:
        db.close()
