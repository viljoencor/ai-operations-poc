import React, { useEffect, useState } from 'react';
import IntegrationTrace from './IntegrationTrace.jsx';
import './integration-trace.css';
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bot, Check, CheckCircle2,
  ChevronRight, CircleAlert, Clock3, CreditCard, Database, FileClock, GitBranch, Layers3,
  LockKeyhole, RefreshCw, Search, Server, ShieldCheck, Sparkles, TicketCheck, Workflow, XCircle, BrainCircuit } from 'lucide-react';

const CASES = [
  { id:'BK-2047', title:'Recover a failed confirmation', sub:'Captured payment · Active inventory', level:'actionable' },
  { id:'BK-2048', title:'Payment not captured', sub:'Declined payment · Must block', level:'blocked' },
  { id:'BK-2049', title:'Already confirmed', sub:'Healthy booking · No action', level:'normal' },
  { id:'BK-2050', title:'Inventory hold expired', sub:'Captured payment · Unsafe to retry', level:'blocked' },
];

function Badge({status}) {
  const label = (status || '').replaceAll('_',' ');
  const kind = status === 'COMPLETED' ? 'good' : status === 'AWAITING_APPROVAL' ? 'amber' : status === 'BLOCKED' ? 'bad' : status === 'INCOMPLETE' || status === 'EXECUTION_UNCERTAIN' ? 'bad' : 'neutral';
  return <span className={`badge ${kind}`}><span className="badge-dot" />{label}</span>;
}

async function api(path, options) {
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error(`HTTP ${response.status}: unexpected response`); }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data));
  return data;
}

function StateCard({icon: Icon, name, value, secondary, ready}) {
  return <div className="state-card">
    <div className="state-card-head"><div className="state-icon"><Icon size={17} /></div><span>{name}</span><span className={`state-indicator ${ready ? 'ready' : 'not-ready'}`}/></div>
    <div className="state-value">{value || 'Unavailable'}</div>
    <div className="state-secondary">{secondary}</div>
  </div>;
}


export default function App() {
  const [query, setQuery] = useState('Investigate booking BK-2047. Payment was captured but provider confirmation failed.');
  const [requester, setRequester] = useState('operations.analyst');
  const [approver, setApprover] = useState('team.lead');
  const [token, setToken] = useState('');
  const [current, setCurrent] = useState(null);
  const [recent, setRecent] = useState([]);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    try {
      const [items, cfg] = await Promise.all([api('/api/investigations'), api('/api/config')]);
      setRecent(items); setConfig(cfg);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); }, []);
  // The backend starts investigations asynchronously; the UI polls the
  // persisted audit record while the operation runs. No invented call timings.
  useEffect(() => {
    if (!current?.id || (!busy && !approving)) return;
    let cancelled = false;
    let inFlight = false;
    const investigationId = current.id;
    async function pollInvestigation() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const result = await api(`/api/investigations/${investigationId}`);
        if (cancelled) return;
        setCurrent(previous => previous?.id === investigationId ? result : previous);
        if (busy && result.status !== 'INVESTIGATING') {
          setBusy(false);
          setNotice(`Investigation ${investigationId} finished its read-only checks. Explore the recorded trace below.`);
          refresh();
        }
      } catch (err) {
        if (!cancelled) setError(`Trace polling failed: ${err.message}`);
      } finally { inFlight = false; }
    }
    pollInvestigation();
    const interval = setInterval(pollInvestigation, 350);
    return () => { cancelled = true; clearInterval(interval); };
  }, [current?.id, busy, approving]);

  async function investigate(evt) {
    evt?.preventDefault(); setBusy(true); setCurrent(null); setError(''); setNotice('');
    try {
      const result = await api('/api/investigations/start', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({query, requested_by: requester}),
      });
      setCurrent(result); setNotice(`Investigation ${result.id} started. API calls are being recorded below.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  async function approve(evt) {
    evt.preventDefault(); if (!current) return;
    setApproving(true); setError(''); setNotice('');
    try {
      const result = await api(`/api/investigations/${current.id}/approve`, {
        method:'POST', headers:{'Content-Type':'application/json', 'X-Approval-Token': token},
        body:JSON.stringify({approved_by:approver}),
      });
      setCurrent(result); setNotice('Approval processed. Review the latest status and audit events.'); setToken(''); await refresh();
    } catch (err) { setError(err.message); }
    finally { setApproving(false); }
  }
  async function selectInvestigation(id) {
    setError(''); setNotice('');
    try { setCurrent(await api(`/api/investigations/${id}`)); } catch(err) { setError(err.message); }
  }
  const snapshot = current?.snapshot ?? {};
  const isPending = current?.status === 'AWAITING_APPROVAL';
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Workflow size={22} strokeWidth={2.3}/></div><div><strong>Systems</strong><span>OPERATIONS INTELLIGENCE</span></div></div>
      <nav className="nav-list">
        <div className="nav-item active"><Layers3 size={18}/> Control centre <span className="nav-trail"/></div>
      </nav>
      <div className="sidebar-divider"/>
      <div className="section-label">CONNECTED SYSTEMS</div>
      <div className="system-nav"><span className="online-dot"/><Server size={16}/> Booking service <span>API</span></div>
      <div className="system-nav"><span className="online-dot"/><CreditCard size={16}/> Payment service <span>API</span></div>
      <div className="system-nav"><span className="online-dot"/><Database size={16}/> Inventory service <span>API</span></div>
      <div className="sidebar-divider"/>
      <div className="security-card"><ShieldCheck size={20}/><strong>Human-controlled by design</strong><p>No model-generated write operations. Every mutation requires approval and policy revalidation.</p></div>
    </aside>

    <main className="main">
      <div className="content">
        <div className="stats-row">
          <div className="metric"><div className="metric-label">CONNECTED SERVICES <Server size={15}/></div><div className="metric-number">03<span className="metric-hint">isolated APIs</span></div></div>
          <div className="metric"><div className="metric-label">INVESTIGATIONS <Search size={15}/></div><div className="metric-number">{String(recent.length).padStart(2,'0')}<span className="metric-hint">in local audit store</span></div></div>
          <div className="metric"><div className="metric-label">EXECUTION POLICY <LockKeyhole size={15}/></div><div className="metric-number policy">Approval<span className="metric-hint">required for writes</span></div></div>
          <div className="metric"><div className="metric-label">PLANNER MODE <Bot size={15}/></div><div className="metric-number policy">{config?.planner_mode === 'ollama' ? 'Ollama' : 'Rules'}<span className="metric-hint">{config?.planner_mode === 'ollama' ? 'local model' : 'deterministic baseline'}</span></div></div>
        </div>

        <div className="grid-main">
          <section className="panel composer-panel"><div className="panel-heading"><div><div className="section-kicker">01 / INVESTIGATE</div><h2>Start an investigation</h2><p>Describe a business-system inconsistency. The orchestrator calls approved read-only APIs.</p></div><div className="panel-header-icon"><Sparkles size={21}/></div></div>
            <form onSubmit={investigate} className="investigate-form"><label htmlFor="question">NATURAL LANGUAGE REQUEST</label><textarea id="question" rows={4} value={query} onChange={e=>setQuery(e.target.value)} spellCheck={false}/><div className="form-row"><div className="actor-control"><label htmlFor="requester">REQUESTED BY</label><input id="requester" value={requester} onChange={e=>setRequester(e.target.value)} /></div><button className="primary-button" disabled={busy || query.length<8 || requester.length<2} type="submit">{busy ? <RefreshCw className="spin" size={17}/> : <Search size={17}/>} {busy ? 'Investigating…' : 'Run investigation'} <ArrowRight size={16}/></button></div></form>
            <div className="quick-title">TRY A SCENARIO <span>four seeded cases</span></div>
            <div className="cases">{CASES.map(item=><button key={item.id} className="case" type="button" onClick={()=>{setQuery(`Investigate booking ${item.id}. Check the booking, payment and inventory systems for inconsistencies.`);setError('');setNotice('');}}><span className={`case-bullet ${item.level}`}/><span className="case-main"><b>{item.id}</b><small>{item.title}</small><em>{item.sub}</em></span><ArrowUpRight size={15} className="case-arrow"/></button>)}</div>
          </section>

        </div>

        <IntegrationTrace current={current} config={config} busy={busy} approving={approving}/>

        {error && <div className="alert error"><CircleAlert size={18}/> {error}<button onClick={()=>setError('')}>Dismiss</button></div>}
        {notice && <div className="alert success"><CheckCircle2 size={18}/> {notice}<button onClick={()=>setNotice('')}>Dismiss</button></div>}

        <div className="results-heading"><div><span className="section-kicker">02 / FINDINGS</span><h2>Investigation results</h2></div><button className="subtle-button" onClick={()=>{refresh(); if(current)selectInvestigation(current.id);}}><RefreshCw size={15}/> Refresh</button></div>
        {!current ? <div className="empty-state"><div className="empty-icon"><Search size={27}/></div><h3>No investigation selected</h3><p>Run one of the sample scenarios to see three independent systems reconciled in real time.</p></div> : <div className="results-stack">
          <div className="result-title"><div><div className="result-id">{current.id} <span className="separator">/</span> {current.booking_id}</div><h3>{current.summary}</h3><div className="result-description">Requested by {current.requested_by} · {new Date(current.created_at).toLocaleString()} · {current.planner} planner</div></div><Badge status={current.status}/></div>
          <div className="state-grid"><StateCard icon={Server} name="BOOKING" value={snapshot.booking?.status?.replaceAll('_',' ')} secondary={`Provider sync: ${snapshot.booking?.sync_status || 'unknown'}`} ready={snapshot.booking?.sync_status === 'COMPLETE'}/><StateCard icon={CreditCard} name="PAYMENT" value={snapshot.payment?.status} secondary={snapshot.payment ? `R ${Number(snapshot.payment.amount_zar).toLocaleString('en-ZA')} · ${snapshot.payment.reference}` : 'No response'} ready={snapshot.payment?.status === 'CAPTURED'}/><StateCard icon={Database} name="INVENTORY" value={snapshot.inventory?.hold_status} secondary={snapshot.inventory?.provider || 'No response'} ready={snapshot.inventory?.hold_status === 'ACTIVE' || snapshot.inventory?.hold_status === 'CONSUMED'}/></div>
          {snapshot.ai_assessment && <div className="ai-brief"><div className="ai-brief-heading"><Bot size={18}/><strong>Local AI operator briefing</strong><span>ADVISORY ONLY</span></div>{snapshot.ai_assessment.unavailable ? <p>{snapshot.ai_assessment.unavailable}</p> : <><p><b>Observation: </b>{snapshot.ai_assessment.observation}</p><p><b>Possible cause: </b>{snapshot.ai_assessment.possible_cause}</p><p><b>Suggested follow-up: </b>{snapshot.ai_assessment.suggested_follow_up}</p></>}<small>The model cannot authorise or execute actions. Service-owned facts and deterministic policy prevail.</small></div>}
          <div className={`decision ${isPending?'decision-await':current.status==='COMPLETED'?'decision-done':'decision-block'}`}><div className="decision-intro"><div className="decision-icon">{isPending?<LockKeyhole size={20}/>:current.status==='COMPLETED'?<CheckCircle2 size={20}/>:<CircleAlert size={20}/>}</div><div><strong>{isPending?'Human approval required':current.status==='COMPLETED'?'Action completed':'No automated action available'}</strong><p>{current.reason}</p></div></div>{isPending && <form className="approval-form" onSubmit={approve}><div className="approval-fields"><label>APPROVER<input required value={approver} onChange={e=>setApprover(e.target.value)} placeholder="team.lead"/></label><label>LOCAL DEMO APPROVAL TOKEN<input required type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder="Enter token from .env"/></label></div><button disabled={approving || !token || !approver} type="submit" className="approve-button">{approving?'Rechecking systems…':'Approve controlled retry'} <ArrowRight size={17}/></button><small className="approval-disclaimer">Demo authentication only. A different actor from the requester is required. Real SSO/RBAC is not implemented.</small></form>}</div>
          <div className="audit-panel"><div className="audit-top"><div><span className="section-kicker">03 / EVIDENCE</span><h3>Investigation audit timeline</h3></div><span>{current.events?.length || 0} events</span></div><div className="timeline">{(current.events||[]).map((e,i)=><div className="timeline-item" key={i}><div className="timeline-line"><div className="timeline-dot"/></div><div className="event-text"><div className="event-row"><strong>{e.action.replaceAll('_',' ')}</strong><time>{new Date(e.occurred_at).toLocaleTimeString()}</time></div><p>{e.detail}</p><small>Actor: {e.actor}</small></div></div>)}</div></div>
        </div>}

        <div className="results-heading recent-title"><div><span className="section-kicker">HISTORY</span><h2>Recent investigations</h2></div></div>
        <div className="history-panel">{recent.length===0 ? <p className="history-empty">Your investigation history will appear here.</p> : recent.map(item=><button onClick={()=>selectInvestigation(item.id)} className="history-row" key={item.id}><div className="history-left"><div className="history-icon"><FileClock size={17}/></div><div><strong>{item.booking_id}</strong><span>{item.id} · {new Date(item.created_at).toLocaleString()}</span></div></div><Badge status={item.status}/><ChevronRight size={18} className="history-arrow"/></button>)}</div>
        <footer>SYNTHETIC DATA ONLY · NO LIVE BOOKING OR PAYMENT SYSTEMS CONNECTED <span>Built to explore safe AI + system-to-system orchestration</span></footer>
      </div>
    </main>
  </div>;
}
