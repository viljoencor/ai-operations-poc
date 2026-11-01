import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    db_path: str = os.getenv("ORCHESTRATOR_DB", "/tmp/orchestrator.db")
    planner_mode: str = os.getenv("PLANNER_MODE", "mock").lower()
    ollama_url: str = os.getenv("OLLAMA_URL", "http://ollama:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5:3b")
    approval_token: str = os.getenv("APPROVAL_TOKEN", "local-demo-approval-token")
    service_token: str = os.getenv("SERVICE_TOKEN", "local-demo-service-token")
    booking_url: str = os.getenv("BOOKING_URL", "http://booking-system:8000")
    payment_url: str = os.getenv("PAYMENT_URL", "http://payment-system:8000")
    inventory_url: str = os.getenv("INVENTORY_URL", "http://inventory-system:8000")


settings = Config()
