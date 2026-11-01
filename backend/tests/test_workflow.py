import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from app.planner import BOOKING_PATTERN
from app.store import Store
from app.workflow import SystemGateway, evaluate, investigate, approve_and_execute


def snapshot(*, booking="PENDING_PROVIDER", sync="FAILED", payment="CAPTURED", hold="ACTIVE"):
    return {
        "booking": {"booking_id": "BK-2047", "status": booking, "sync_status": sync},
        "payment": {"booking_id": "BK-2047", "status": payment, "amount_zar": 2850},
        "inventory": {"booking_id": "BK-2047", "hold_status": hold},
    }


def run(coro):
    return asyncio.run(coro)


def test_safe_policy_all_required():
    assert evaluate(snapshot())[0] == "AWAITING_APPROVAL"
    assert evaluate(snapshot(payment="DECLINED"))[0] == "BLOCKED"
    assert evaluate(snapshot(hold="EXPIRED"))[0] == "BLOCKED"
    assert evaluate(snapshot(sync="COMPLETE"))[0] == "BLOCKED"
    assert evaluate(snapshot(booking="CONFIRMED"))[0] == "BLOCKED"


def test_booking_id_extraction():
    assert BOOKING_PATTERN.findall("Please investigate bk-2047") == ["bk-2047"]


def test_store_atomic_approval_and_maker_checker(tmp_path):
    store = Store(tmp_path / "state.db")
    item = store.create("BK-2047", "analyst", "Investigate BK-2047", "deterministic")
    store.finish(item, "AWAITING_APPROVAL", "Needs approval", "Reason", snapshot())
    assert store.claim_approval(item, "analyst") == "same_actor"
    assert store.claim_approval(item, "team.lead") == "ok"
    assert store.claim_approval(item, "other.lead") == "invalid_state"
    assert store.get(item)["approved_by"] == "team.lead"


class FakeGateway:
    def __init__(self, initial, changed=None):
        self.initial, self.changed = initial, changed
        self.reads = 0
        self.writes = 0

    async def get_snapshot(self, booking_id, investigation_id):
        self.reads += 1
        return self.changed if self.reads > 1 and self.changed is not None else self.initial

    async def retry_confirmation(self, booking_id, investigation_id):
        self.writes += 1
        return {"booking_id": booking_id, "status": "CONFIRMED", "sync_status": "COMPLETE"}


def test_full_approved_retry(tmp_path):
    store = Store(tmp_path / "state.db")
    gateway = FakeGateway(snapshot())
    item = store.create("BK-2047", "analyst", "Investigate BK-2047", "deterministic")
    run(investigate(gateway, store, item, "BK-2047"))
    assert store.get(item)["status"] == "AWAITING_APPROVAL"
    run(approve_and_execute(gateway, store, item, "team.lead"))
    assert gateway.writes == 1
    assert gateway.reads == 2
    assert store.get(item)["status"] == "COMPLETED"
    assert "APPROVAL_GRANTED" in [event["action"] for event in store.get(item)["events"]]


def test_revalidation_blocks_changed_payment(tmp_path):
    store = Store(tmp_path / "state.db")
    gateway = FakeGateway(snapshot(), changed=snapshot(payment="DECLINED"))
    item = store.create("BK-2047", "analyst", "Investigate BK-2047", "deterministic")
    run(investigate(gateway, store, item, "BK-2047"))
    run(approve_and_execute(gateway, store, item, "team.lead"))
    assert store.get(item)["status"] == "BLOCKED"
    assert gateway.writes == 0


def test_no_mutation_in_unsafe_case(tmp_path):
    store = Store(tmp_path / "state.db")
    gateway = FakeGateway(snapshot(hold="EXPIRED"))
    item = store.create("BK-2050", "analyst", "Investigate BK-2050", "deterministic")
    run(investigate(gateway, store, item, "BK-2050"))
    assert store.get(item)["status"] == "BLOCKED"
    with pytest.raises(HTTPException) as exc:
        run(approve_and_execute(gateway, store, item, "team.lead"))
    assert exc.value.status_code == 409
    assert gateway.writes == 0


def test_planner_supports_one_explicit_booking_id():
    from app.planner import plan_request
    plan, mode = run(plan_request('Investigate booking BK-2047 now'))
    assert mode == 'deterministic'
    assert plan.booking_id == 'BK-2047'
    assert plan.workflow == 'reconcile_booking'
    with pytest.raises(HTTPException) as exc:
        run(plan_request('Investigate BK-2047 and BK-2048'))
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        run(plan_request('Investigate a broken booking without an ID'))
    assert exc.value.status_code == 422
