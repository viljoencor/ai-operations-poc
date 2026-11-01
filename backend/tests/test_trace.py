"""Tests for the HTTP-level audit metadata used by the interactive frontend."""
import asyncio
import json

import httpx

from app.store import Store
from app.workflow import SystemGateway


def run(coro):
    return asyncio.run(coro)


def test_gateway_records_successful_http_call_without_secrets(tmp_path):
    store = Store(tmp_path / 'trace.db')
    investigation_id = store.create('BK-2047', 'analyst', 'Investigate booking BK-2047', 'deterministic')

    def handler(request):
        assert request.headers['X-Request-ID'] == investigation_id
        return httpx.Response(200, json={'status': 'CAPTURED'})

    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await SystemGateway(client=client, store=store)._request(
                'GET', 'http://test/payments/by-booking/BK-2047', investigation_id,
                service='payment', phase='investigation')

    assert run(invoke())['status'] == 'CAPTURED'
    events = [e for e in store.get(investigation_id)['events'] if e['action'].startswith('API_CALL_')]
    assert [e['action'] for e in events] == ['API_CALL_STARTED', 'API_CALL_SUCCEEDED']
    metadata = json.loads(events[-1]['detail'])
    assert metadata['service'] == 'payment'
    assert metadata['method'] == 'GET'
    assert metadata['path'] == '/payments/by-booking/BK-2047'
    assert metadata['status_code'] == 200
    assert metadata['duration_ms'] >= 0
    assert 'X-Service-Token' not in events[-1]['detail']


def test_gateway_records_failed_http_call(tmp_path):
    store = Store(tmp_path / 'trace.db')
    investigation_id = store.create('BK-2047', 'analyst', 'Investigate booking BK-2047', 'deterministic')

    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(503))) as client:
            try:
                await SystemGateway(client=client, store=store)._request(
                    'GET', 'http://test/bookings/BK-2047', investigation_id,
                    service='booking', phase='revalidation')
            except httpx.HTTPStatusError:
                pass

    run(invoke())
    events = store.get(investigation_id)['events']
    assert any(e['action'] == 'API_CALL_FAILED' for e in events)
    failed = next(e for e in events if e['action'] == 'API_CALL_FAILED')
    assert json.loads(failed['detail'])['phase'] == 'revalidation'
