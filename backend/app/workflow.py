"""Trusted runbook: bounded cross-service reads and a guarded, approved mutation."""
import asyncio
import json
import time
from urllib.parse import urlsplit
import httpx
from fastapi import HTTPException

from .config import settings
from .planner import explain_evidence


class SystemGateway:
    def __init__(self, client=None, store=None):
        self.client = client
        self.store = store

    def _trace(self, investigation_id, action, **fields):
        if self.store is not None:
            # Audit only safe HTTP metadata. Never log tokens, response bodies,
            # payment data or other credentials in the integration trace.
            self.store.event(investigation_id, "integration-gateway", action,
                             json.dumps(fields, separators=(",", ":")))

    async def _request(self, method, url, request_id, *, json=None,
                       idempotency_key=None, service="unknown", phase="investigation"):
        headers = {"X-Service-Token": settings.service_token, "X-Request-ID": request_id}
        if idempotency_key:
            headers["X-Idempotency-Key"] = idempotency_key
        path = urlsplit(url).path  # No host, credential, or query-string leakage.
        metadata = {"service": service, "phase": phase, "method": method, "path": path}
        self._trace(request_id, "API_CALL_STARTED", **metadata)
        start = time.perf_counter()
        try:
            if self.client is not None:
                response = await self.client.request(method, url, headers=headers, json=json, timeout=4)
            else:
                async with httpx.AsyncClient(timeout=4) as client:
                    response = await client.request(method, url, headers=headers, json=json)
            elapsed = round((time.perf_counter() - start) * 1000)
            response.raise_for_status()
            body = response.json()
            self._trace(request_id, "API_CALL_SUCCEEDED", **metadata,
                        status_code=response.status_code, duration_ms=elapsed)
            return body
        except (httpx.HTTPError, ValueError) as exc:
            self._trace(request_id, "API_CALL_FAILED", **metadata,
                        duration_ms=round((time.perf_counter() - start) * 1000),
                        error_type=type(exc).__name__)
            raise

    async def get_snapshot(self, booking_id, investigation_id, phase="investigation"):
        endpoints = {
            "booking": f"{settings.booking_url}/bookings/{booking_id}",
            "payment": f"{settings.payment_url}/payments/by-booking/{booking_id}",
            "inventory": f"{settings.inventory_url}/holds/by-booking/{booking_id}",
        }
        # Reads run concurrently; audit events reflect actual call completion
        # order rather than an invented sequential animation.
        values = await asyncio.gather(*(
            self._request("GET", url, investigation_id, service=service, phase=phase)
            for service, url in endpoints.items()
        ))
        return dict(zip(endpoints, values))

    async def retry_confirmation(self, booking_id, investigation_id):
        return await self._request(
            "POST", f"{settings.booking_url}/bookings/{booking_id}/retry-confirmation",
            investigation_id, json={"reason": "Human-approved reconciliation retry"},
            idempotency_key=investigation_id, service="booking", phase="execution",
        )


def evaluate(snapshot):
    booking, payment, inventory = (snapshot[k] for k in ("booking", "payment", "inventory"))
    conditions = [
        (booking["status"] == "PENDING_PROVIDER" and booking["sync_status"] == "FAILED", "Booking is pending provider confirmation with a failed sync"),
        (payment["status"] == "CAPTURED", "Payment is captured"),
        (inventory["hold_status"] == "ACTIVE", "Inventory hold is active"),
    ]
    if all(condition for condition, _ in conditions):
        return (
            "AWAITING_APPROVAL",
            "Payment captured; provider confirmation failed; inventory hold remains active.",
            "A human approver may authorise one retry of provider confirmation. The three systems will be rechecked before execution.",
        )
    failed = [label for condition, label in conditions if not condition]
    return (
        "BLOCKED",
        "Automatic remediation is not safe for this booking.",
        "Unmet prerequisites: " + "; ".join(failed) + ". Investigate manually; no write action is offered.",
    )


async def investigate(gateway, store, investigation_id, booking_id, planner="deterministic"):
    try:
        snapshot = await gateway.get_snapshot(booking_id, investigation_id)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        store.finish(investigation_id, "INCOMPLETE", "Unable to read every required system.",
                     "At least one upstream system failed or returned invalid data. No mutation is permitted.", {})
        store.event(investigation_id, "orchestrator", "SYSTEM_READ_FAILED", type(exc).__name__)
        return
    store.event(investigation_id, "orchestrator", "SYSTEMS_READ", "Read booking, payment and inventory through authenticated APIs")
    status, summary, reason = evaluate(snapshot)
    if planner == "ollama":
        snapshot["ai_assessment"] = await explain_evidence(snapshot, status)
        store.event(investigation_id, "orchestrator", "AI_ASSESSMENT", "Local LLM produced advisory commentary; policy remains deterministic")
    store.finish(investigation_id, status, summary, reason, snapshot)


async def approve_and_execute(gateway, store, investigation_id, approved_by):
    claim = store.claim_approval(investigation_id, approved_by)
    if claim == "not_found":
        raise HTTPException(status_code=404, detail="Investigation not found")
    if claim == "same_actor":
        raise HTTPException(status_code=403, detail="The requester cannot approve their own action")
    if claim != "ok":
        raise HTTPException(status_code=409, detail="This investigation is not awaiting approval")

    store.event(investigation_id, approved_by, "APPROVAL_GRANTED", "Approved one provider confirmation retry")
    record = store.get(investigation_id)
    booking_id = record["booking_id"]
    try:
        # Existing tests provide simple gateways with the original two-argument
        # method; the live SystemGateway supports a phase for audit tracing.
        if isinstance(gateway, SystemGateway):
            fresh = await gateway.get_snapshot(booking_id, investigation_id, phase="revalidation")
        else:
            fresh = await gateway.get_snapshot(booking_id, investigation_id)
        status, _summary, reason = evaluate(fresh)
        if status != "AWAITING_APPROVAL":
            store.set_status(investigation_id, "BLOCKED", "Conditions changed since investigation. " + reason)
            store.event(investigation_id, "orchestrator", "REVALIDATION_BLOCKED", "No write executed")
            return
        store.event(investigation_id, "orchestrator", "PRECONDITIONS_RECHECKED", "All three systems still satisfy the retry policy")
        result = await gateway.retry_confirmation(booking_id, investigation_id)
        if result.get("status") != "CONFIRMED" or result.get("sync_status") != "COMPLETE":
            raise ValueError("Provider retry did not return a confirmed outcome")
        # The booking service's acknowledged state is the authoritative
        # result of this mock command. Preserve other pre-write evidence.
        fresh["booking"] = result
        store.replace_snapshot(investigation_id, fresh)
        store.set_status(investigation_id, "COMPLETED", "Approved retry executed; simulated provider confirmation returned CONFIRMED.")
        store.event(investigation_id, "orchestrator", "RETRY_COMPLETED", f"Idempotent write to booking system for {booking_id}")
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        store.set_status(investigation_id, "EXECUTION_UNCERTAIN", "Execution failed or result could not be verified. Reconcile before any further retry.")
        store.event(investigation_id, "orchestrator", "EXECUTION_UNCERTAIN", type(exc).__name__)
