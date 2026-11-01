import hmac
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import settings
from .planner import plan_request
from .store import Store
from .workflow import SystemGateway, investigate, approve_and_execute

store = Store(settings.db_path)

app = FastAPI(title="Business Systems AI Orchestrator", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5174", "http://127.0.0.1:5174"],
                   allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-Approval-Token"])


class InvestigateRequest(BaseModel):
    query: str = Field(min_length=8, max_length=500)
    requested_by: str = Field(min_length=2, max_length=60, pattern=r"^[a-zA-Z0-9._@-]+$")


class ApproveRequest(BaseModel):
    approved_by: str = Field(min_length=2, max_length=60, pattern=r"^[a-zA-Z0-9._@-]+$")


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/config")
async def config():
    return {"planner_mode": settings.planner_mode, "model": settings.ollama_model if settings.planner_mode == "ollama" else None,
            "environment": "SIMULATED ON-PREMISES", "approval_required": True}


@app.get("/api/investigations")
async def recent():
    return store.list_recent()


@app.get("/api/investigations/{investigation_id}")
async def get_one(investigation_id: str):
    record = store.get(investigation_id)
    if not record:
        raise HTTPException(status_code=404, detail="Investigation not found")
    return record


@app.post("/api/investigations/start", status_code=202)
async def start_investigation(payload: InvestigateRequest, background_tasks: BackgroundTasks):
    """Nonblocking POC endpoint, used for progress polling and live API traces.

    BackgroundTasks are intentionally demo-only: production needs a durable
    worker/queue so investigations survive process restarts.
    """
    plan, planner = await plan_request(payload.query)
    investigation_id = store.create(plan.booking_id, payload.requested_by, payload.query, planner)
    background_tasks.add_task(investigate, SystemGateway(store=store), store,
                              investigation_id, plan.booking_id, planner)
    return store.get(investigation_id)


@app.post("/api/investigations", status_code=201)
async def new_investigation(payload: InvestigateRequest):
    plan, planner = await plan_request(payload.query)
    investigation_id = store.create(plan.booking_id, payload.requested_by, payload.query, planner)
    await investigate(SystemGateway(store=store), store, investigation_id, plan.booking_id, planner)
    return store.get(investigation_id)


@app.post("/api/investigations/{investigation_id}/approve")
async def approve(investigation_id: str, payload: ApproveRequest, x_approval_token: str = Header(default="")):
    if not hmac.compare_digest(x_approval_token, settings.approval_token):
        raise HTTPException(status_code=403, detail="Invalid approval token")
    await approve_and_execute(SystemGateway(store=store), store, investigation_id, payload.approved_by)
    return store.get(investigation_id)
