import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDown, ArrowRight, Bot, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, Clock3, CreditCard, Database, GitBranch,
  LockKeyhole, Pause, Play, RotateCcw, Server, ShieldCheck, TerminalSquare,
} from 'lucide-react';

const SERVICES = [
  { id: 'booking', label: 'Bookings', icon: Server, endpoint: '/bookings/{id}', responsibility: 'Booking state and provider confirmation' },
  { id: 'payment', label: 'Payments', icon: CreditCard, endpoint: '/payments/by-booking/{id}', responsibility: 'Payment capture and transaction reference' },
  { id: 'inventory', label: 'Inventory', icon: Database, endpoint: '/holds/by-booking/{id}', responsibility: 'Inventory hold and availability' },
];

function parseEvent(event) {
  if (!event) return null;
  let metadata = {};
  if (event.action.startsWith('API_CALL_')) {
    try { metadata = JSON.parse(event.detail); } catch { /* Old audit event format */ }
  }
  return { ...event, metadata };
}

function describe(event) {
  if (!event) return { title: 'Select an event', why: 'Run an investigation, then select a recorded event to explain how the systems communicate.' };
  const m = event.metadata;
  switch (event.action) {
    case 'INVESTIGATION_STARTED':
      return { title: 'Request accepted and correlated', why: 'The orchestrator stores the investigation ID and requester, then begins a bounded reconciliation runbook. This ID is also sent as X-Request-ID on downstream calls.' };
    case 'API_CALL_STARTED':
      return { title: `Calling ${m.service || 'a business service'}`, why: `The integration gateway sends an authenticated ${m.method || 'HTTP'} request to a separate service. This is a real backend request event, recorded before the call. Reads are issued concurrently, not in a fixed visual order.` };
    case 'API_CALL_SUCCEEDED':
      return { title: `${m.service || 'Service'} responded`, why: `The downstream service returned HTTP ${m.status_code ?? 200} in ${m.duration_ms ?? '?'} ms. The result contributes to the trusted evidence used by the policy engine.` };
    case 'API_CALL_FAILED':
      return { title: 'Downstream request failed', why: 'The gateway recorded a failed API operation. The orchestrator must fail closed: if required evidence cannot be retrieved, it cannot perform a write.' };
    case 'SYSTEMS_READ':
      return { title: 'Authoritative evidence collected', why: 'The orchestrator has responses from the booking, payment and inventory APIs. It evaluates these business facts rather than relying on model-generated facts.' };
    case 'AI_ASSESSMENT':
      return { title: 'Optional local AI briefing', why: 'Ollama can summarise the evidence and provide advisory analysis. The LLM does not decide eligibility or execute operations.' };
    case 'EVALUATION_COMPLETED':
      return { title: 'Deterministic policy evaluated', why: 'The policy requires booking PENDING_PROVIDER, sync FAILED, payment CAPTURED and inventory hold ACTIVE. Only then can a retry be offered for human approval.' };
    case 'APPROVAL_GRANTED':
      return { title: 'Human approval recorded', why: 'The approval token is checked by the API and the requester cannot approve their own investigation. An atomic database claim prevents duplicate approval.' };
    case 'PRECONDITIONS_RECHECKED':
      return { title: 'Live business state revalidated', why: 'Before issuing the write, the gateway queries all three systems again. This guards against state changes since the original investigation.' };
    case 'RETRY_COMPLETED':
      return { title: 'Idempotent booking retry confirmed', why: 'A guarded POST was sent to Bookings with the investigation ID as the idempotency key. The booking API returned its authoritative CONFIRMED result.' };
    case 'REVALIDATION_BLOCKED':
      return { title: 'Write prevented', why: 'The business conditions changed during approval. The policy correctly halted execution; no booking mutation was attempted.' };
    case 'SYSTEM_READ_FAILED':
      return { title: 'Required evidence unavailable', why: 'One or more read operations failed, so the investigation is incomplete and no mutation is authorised.' };
    case 'EXECUTION_UNCERTAIN':
      return { title: 'Outcome requires reconciliation', why: 'The write outcome is uncertain. The system must reconcile before considering another attempt, rather than blindly repeating the operation.' };
    default:
      return { title: event.action.replaceAll('_', ' ').toLowerCase(), why: event.detail };
  }
}

function statusLabel(status) {
  return status === 'done' ? '200 / Complete' : status === 'active' ? 'Calling…' : status === 'error' ? 'Failed' : 'Not called';
}

export default function IntegrationTrace({ current, config, busy, approving }) {
  const events = useMemo(() => (current?.events || []).map(parseEvent), [current?.events]);
  const [cursor, setCursor] = useState(-1);
  const [following, setFollowing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [focusNode, setFocusNode] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setCursor(-1);
    setFollowing(true);
    setPlaying(false);
    setFocusNode(null);
  }, [current?.id]);

  useEffect(() => {
    if (following && !playing) setCursor(events.length - 1);
  }, [events.length, following, playing]);

  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => {
      setCursor(previous => {
        if (previous >= events.length - 1) {
          setPlaying(false);
          return previous;
        }
        return previous + 1;
      });
    }, 1050);
    return () => clearInterval(interval);
  }, [playing, events.length]);

  const selected = events[cursor] ?? null;
  const visible = events.slice(0, cursor + 1);
  const activeApi = selected?.metadata?.service;
  const activePhase = selected?.metadata?.phase;
  const isApi = selected?.action?.startsWith('API_CALL_');
  const serviceState = {};
  for (const service of SERVICES) serviceState[service.id] = { status: 'idle', last: null };
  for (const e of visible) {
    const svc = e.metadata?.service;
    if (svc && serviceState[svc]) {
      serviceState[svc] = {
        status: e.action === 'API_CALL_STARTED' ? 'active' : e.action === 'API_CALL_FAILED' ? 'error' : 'done',
        last: e,
      };
    }
  }

  const has = name => visible.some(e => e.action === name);
  const status = current?.status;
  const policySeen = has('EVALUATION_COMPLETED');
  const approved = has('APPROVAL_GRANTED');
  const completed = has('RETRY_COMPLETED');
  const writeStarted = visible.some(e => e.action === 'API_CALL_STARTED' && e.metadata?.phase === 'execution');
  const blocked = has('REVALIDATION_BLOCKED') || has('SYSTEM_READ_FAILED');
  const policyStatus = policySeen ? 'done' : has('SYSTEMS_READ') ? 'active' : 'idle';
  const approvalStatus = approved ? 'done' : policySeen && status === 'AWAITING_APPROVAL' ? 'waiting' : 'idle';
  const actionStatus = completed ? 'done' : writeStarted ? 'active' : blocked ? 'error' : 'idle';

  const selectIndex = index => {
    setCursor(index);
    setFollowing(false);
    setPlaying(false);
    setFocusNode(null);
  };
  const selectService = id => {
    const matches = events.map((e, i) => [e, i]).filter(([e]) => e.metadata?.service === id);
    if (matches.length) selectIndex(matches[matches.length - 1][1]);
    else { setFollowing(false); setPlaying(false); setFocusNode(id); }
  };
  const replay = () => { setFollowing(false); setPlaying(true); setCursor(-1); setFocusNode(null); };
  const followLive = () => { setPlaying(false); setFollowing(true); setFocusNode(null); setCursor(events.length - 1); };
  const explanation = focusNode
    ? { title: SERVICES.find(s => s.id === focusNode)?.label || 'Integration service', why: SERVICES.find(s => s.id === focusNode)?.responsibility || '' }
    : describe(selected);

  return <section className={`panel trace-panel ${expanded ? 'trace-panel-open' : 'trace-panel-closed'}`} aria-label="Interactive integration sequence">
    <button type="button" className="trace-collapse-trigger"
      aria-expanded={expanded} aria-controls="integration-trace-details"
      onClick={() => { setExpanded(previous => !previous); setPlaying(false); }}>
      <span className="trace-collapse-copy">
        <span className="section-kicker">SYSTEM LANDSCAPE / INTERVIEW DEMO</span>
        <span className="trace-collapse-title">Inside an AI-assisted investigation</span>
        {expanded && <span className="trace-collapse-description">Follow a real API trace from an operator request, through three independent business systems, to a policy-controlled decision.</span>}
      </span>
      <span className="trace-collapse-control">
        <span className={`trace-badge ${busy || approving ? '' : 'subtle'}`}><Activity size={14}/> {busy || approving ? 'Recording' : current ? `${events.length} trace events` : 'Ready'}</span>
        <span className="trace-toggle-label">{expanded ? 'Hide walkthrough' : 'Show walkthrough'}</span>
        <ChevronDown size={21} className={`trace-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true"/>
      </span>
    </button>

    {expanded && <div id="integration-trace-details" className="trace-collapse-body">
      <div className="trace-context-line">
        <span className="trace-badge subtle">{config?.planner_mode === 'ollama' ? 'Ollama advisory' : 'Deterministic planner'}</span>
        <span>Use the replay controls to inspect each recorded system-to-system operation.</span>
      </div>

    <div className="trace-tour">
      <div className="trace-stage-intent">
        <div className="trace-overline">01 / ENTRY POINT</div>
        <div className="trace-intent-row">
          <div className="trace-mini-card"><TerminalSquare size={20}/><div><strong>Operations UI</strong><small>Operator describes a problem</small></div></div>
          <div className="trace-inline-link"><span>POST /api/investigations/start</span><ArrowRight size={18}/></div>
          <div className={`trace-mini-card orchestrator ${has('INVESTIGATION_STARTED') ? 'done' : ''}`}><Bot size={20}/><div><strong>AI Orchestrator</strong><small>Intent parsing, trusted runbook, audit ID</small></div></div>
        </div>
      </div>
      <div className="trace-down"><ArrowDown size={20}/><span>Authenticated, correlated, read-only fan-out</span></div>
      <div className="trace-stage-apis">
        <div className="trace-overline">02 / BUSINESS-SYSTEM INTEGRATION</div>
        <div className="trace-service-grid">
          {SERVICES.map(service => {
            const Icon = service.icon;
            const state = serviceState[service.id];
            const selectedNow = (isApi && activeApi === service.id) || focusNode === service.id;
            const event = state.last;
            const timing = event?.metadata?.duration_ms;
            return <button type="button" key={service.id}
              className={`trace-service trace-${state.status} ${selectedNow ? 'trace-selected' : ''}`}
              onClick={() => selectService(service.id)} title={`Inspect ${service.label} API trace`}>
              <div className="trace-service-top"><span className="trace-service-icon"><Icon size={19}/></span><span className={`trace-status-dot ${state.status}`} /></div>
              <strong>{service.label} API</strong>
              <small>{service.responsibility}</small>
              <code>GET {service.endpoint.replace('{id}', current?.booking_id || 'BK-2047')}</code>
              <div className="trace-service-footer"><span>{statusLabel(state.status)}</span><span>{timing != null ? `${timing} ms` : 'On-prem mock service'}</span></div>
            </button>;
          })}
        </div>
        <div className="trace-service-note"><GitBranch size={15}/><span>All three GET calls run concurrently. Each service returns its own authoritative response. Select a card to inspect its recorded calls.</span></div>
      </div>
      <div className="trace-down"><ArrowDown size={20}/><span>Join responses and evaluate deterministic business rules</span></div>
      <div className="trace-decision-grid">
        <div className={`trace-stage-box ${policyStatus}`}>
          <div className="trace-overline">03 / POLICY</div>
          <div className="trace-stage-box-title"><ShieldCheck size={19}/><strong>Validate cross-system state</strong></div>
          <p>Booking pending + provider sync failed + payment captured + hold active.</p>
          <span className="trace-stage-outcome">{policySeen ? (status === 'BLOCKED' ? 'Blocked by policy' : 'Policy evaluated') : 'Waiting for complete evidence'}</span>
        </div>
        <div className="trace-flow-arrow"><ArrowRight size={21}/></div>
        <div className={`trace-stage-box ${approvalStatus}`}>
          <div className="trace-overline">04 / HUMAN GATE</div>
          <div className="trace-stage-box-title"><LockKeyhole size={19}/><strong>Approve controlled action</strong></div>
          <p>Enforce separate approver, approval token and atomic claim.</p>
          <span className="trace-stage-outcome">{approved ? 'Human approval recorded' : approvalStatus === 'waiting' ? 'Waiting for approval' : 'No write authorised'}</span>
        </div>
        <div className="trace-flow-arrow"><ArrowRight size={21}/></div>
        <div className={`trace-stage-box ${actionStatus}`}>
          <div className="trace-overline">05 / GUARDED EXECUTION</div>
          <div className="trace-stage-box-title"><RotateCcw size={19}/><strong>Recheck, then retry</strong></div>
          <p>Re-read all services, then POST with an idempotency key if still safe.</p>
          <span className="trace-stage-outcome">{completed ? 'Confirmed by Booking API' : writeStarted ? 'Executing authorised write' : 'No write executed yet'}</span>
        </div>
      </div>
    </div>

    <div className="trace-workbench">
      <div className="trace-timeline-panel">
        <div className="trace-workbench-heading"><div><div className="section-kicker">06 / EVIDENCE</div><h3>Recorded API events</h3></div><span>{events.length} events</span></div>
        <div className="trace-replay-controls">
          <button type="button" onClick={() => selectIndex(Math.max(-1, cursor - 1))} disabled={cursor < 0} aria-label="Previous event"><ChevronLeft size={16}/></button>
          <button type="button" onClick={() => selectIndex(Math.min(events.length - 1, cursor + 1))} disabled={cursor >= events.length - 1} aria-label="Next event"><ChevronRight size={16}/></button>
          <button type="button" className="trace-control-strong" onClick={() => playing ? setPlaying(false) : replay()} disabled={!events.length}>
            {playing ? <Pause size={14}/> : <Play size={14}/>} {playing ? 'Pause' : 'Replay'}
          </button>
          <button type="button" className={following ? 'trace-follow active' : 'trace-follow'} onClick={followLive} disabled={!events.length}>Follow latest</button>
        </div>
        <div className="trace-event-list" role="list" aria-label="Investigation audit events">
          {events.length ? events.map((event, index) => <button type="button" role="listitem" key={`${index}-${event.action}`}
            className={`trace-event ${index === cursor && !focusNode ? 'selected' : ''} ${index <= cursor ? 'seen' : ''}`}
            onClick={() => selectIndex(index)}>
            <span className="trace-event-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="trace-event-body"><strong>{event.action.replaceAll('_', ' ')}</strong><small>{event.metadata?.method ? `${event.metadata.method} ${event.metadata.path}` : event.actor}</small></span>
            {index === cursor ? <Check size={15}/> : <ChevronRight size={14}/>}
          </button>) : <p className="trace-empty">Run an investigation to see real backend events. Start, response, policy and approval events appear here as they are recorded.</p>}
        </div>
      </div>
      <div className="trace-inspector-panel">
        <div className="trace-workbench-heading"><div><div className="section-kicker">07 / UNDER THE HOOD</div><h3>What happens at this step?</h3></div>{selected?.occurred_at && <span><Clock3 size={12}/> {new Date(selected.occurred_at).toLocaleTimeString()}</span>}</div>
        <div className="trace-inspector-info"><h4>{explanation.title}</h4><p>{explanation.why}</p></div>
        {selected?.metadata?.method && !focusNode && <div className="trace-http-detail">
          <div className="trace-detail-title">Recorded HTTP operation</div>
          <div className="trace-http-line"><span className={`trace-method ${selected.metadata.method?.toLowerCase()}`}>{selected.metadata.method}</span><code>{selected.metadata.path}</code></div>
          <div className="trace-http-facts">
            <div><span>Target service</span><b>{selected.metadata.service}</b></div>
            <div><span>Phase</span><b>{selected.metadata.phase}</b></div>
            <div><span>Result</span><b>{selected.action === 'API_CALL_STARTED' ? 'In flight' : selected.action === 'API_CALL_FAILED' ? selected.metadata.error_type || 'Error' : `HTTP ${selected.metadata.status_code}`}</b></div>
            <div><span>Duration</span><b>{selected.metadata.duration_ms == null ? 'Pending' : `${selected.metadata.duration_ms} ms`}</b></div>
          </div>
        </div>}
        <div className="trace-inspector-footer">
          <CheckCircle2 size={18}/><span><strong>Why this is safe:</strong> AI may interpret or explain, but service APIs provide facts. Policy evaluation, authorisation, revalidation and writes remain deterministic.</span>
        </div>
        <p className="trace-recording-note">This graph uses persisted backend audit events, not timed mock calls. Select steps or replay the captured trace. A running investigation is polled for newly recorded events. Local demo only.</p>
      </div>
    </div>
    </div>}
  </section>;
}
