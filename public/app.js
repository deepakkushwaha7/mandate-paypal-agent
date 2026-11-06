/* Mandate dashboard. Vanilla JS, no build step.
   Sections: helpers · notices · render · payments grid · drawer · modals ·
   rules editor · agent run · toasts · guided tour · live updates */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (n) => '€' + Number(n || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const eur0 = (n) => '€' + Number(n || 0).toLocaleString('en-IE', { maximumFractionDigits: 0 });
  const local = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
  };

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Something went wrong (${res.status}). Please try again.`);
    return json;
  }
  const act = (fn) => async (...a) => {
    try { await fn(...a); } catch (e) { toast(e.message, { error: true }); }
  };
  // Disable a button while its action runs, so nothing is sent twice.
  const busy = (btn, fn) => act(async (...a) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(...a); } finally { btn.disabled = false; }
  });

  // Plain-language status for every order state.
  const STATUS = {
    PAYING: { label: 'Paying…', cls: 'b-held' },
    AUTHORIZED: { label: 'On hold', cls: 'b-held' },
    CAPTURING: { label: 'Paying…', cls: 'b-held' },
    CAPTURED: { label: 'Paid', cls: 'b-paid' },
    NEEDS_APPROVAL: { label: 'Waiting for you', cls: 'b-wait' },
    BLOCKED: { label: 'Blocked', cls: 'b-blocked' },
    FAILED: { label: 'Failed', cls: 'b-failed' },
    VOIDED: { label: 'Undone', cls: 'b-done' },
    REFUNDED: { label: 'Refunded', cls: 'b-done' },
    REJECTED: { label: 'Declined', cls: 'b-done' },
  };
  const DECISION = {
    auto: { title: 'Paid automatically', text: 'It passed every rule, so the agent paid without asking you.' },
    needs_approval: { title: 'Needs your OK', text: 'It went past one of your rules, so it waits for you.' },
    blocked: { title: 'Blocked by your rules', text: 'It broke a hard limit. Nothing was charged.' },
  };
  const DEAD = ['BLOCKED', 'FAILED', 'VOIDED', 'REFUNDED', 'REJECTED'];

  let state = null;
  let skew = 0;
  const secondsLeft = (o) => (o.undoUntil ? Math.max(0, Math.ceil((new Date(o.undoUntil) - (Date.now() + skew)) / 1000)) : 0);
  const statusBadge = (o) => {
    const s = STATUS[o.status] || { label: o.status, cls: 'b-done' };
    const extra = o.status === 'AUTHORIZED' ? ` · undo <span data-left="${esc(o.id)}">${secondsLeft(o)}s</span>` : '';
    return `<span class="badge ${s.cls}">${s.label}${extra}</span>`;
  };
  const shortName = (name) => String(name).split(',')[0];
  const linesText = (o) => o.lines.map((l) => `${l.qty.toLocaleString('en')} × ${shortName(l.name)}`).join(', ');

  // ---------- notices from PayPal redirects ----------
  const params = new URLSearchParams(location.search);
  const NOTICES = {
    'paypal-connected': 'PayPal is saved. Agents can now pay small, in-policy orders without asking you.',
    'paypal-cancelled': 'PayPal was not saved. Agent payments will wait for your approval.',
    approved: 'Approved in PayPal. The payment is on hold and you can still undo it.',
    'approval-cancelled': 'Approval cancelled. The order is still waiting for you.',
  };
  if (NOTICES[params.get('notice')]) {
    setTimeout(() => toast(NOTICES[params.get('notice')]), 300);
    history.replaceState(null, '', '/');
  }

  // ---------- render ----------
  function render() {
    if (!state) return;
    const s = state;
    const m = s.mandate;
    const ai = s.mode.ai;

    $('org').textContent = `${s.company.name} · demo`;
    $('env').innerHTML =
      `<span class="pill ${s.mode.paypal === 'simulated' ? 'off' : ''}">PayPal ${s.mode.paypal === 'simulated' ? 'simulator' : 'sandbox'}</span>` +
      `<span class="pill ${ai ? '' : 'off'}">${ai ? `AI · ${esc(ai.label)}` : 'AI · built-in planner'}</span>`;
    $('ai-tag').textContent = ai ? `${ai.label} · ${ai.model}` : 'Built-in planner';
    $('kill').hidden = !m.active;
    $('paused').hidden = m.active;

    $('welcome-eyebrow').textContent = `Live demo · ${s.mode.paypal === 'simulated' ? 'PayPal simulator' : 'PayPal sandbox'} · Fake money`;
    renderWelcome(s);
    renderBudget(s);
    renderPayPal(s);
    renderRules(s);
    renderAgents(s);
    renderStock(s);
    renderInbox(s);
    renderGrid(s);
    renderLog(s);
    renderDrawer();
    toastNewHolds(s.orders);

    $('run').disabled = s.running || !m.active;
    $('run').textContent = s.running ? 'Agent is working…' : 'Run agent';
  }

  function renderWelcome(s) {
    const steps = [
      { done: Boolean(s.mandate.vaultId), title: 'Save PayPal for your agents', sub: 'Once. Then small orders pay without you.', go: 'card-paypal' },
      { done: (s.mandate.version || 1) > 1, title: 'Set your rules in plain English', sub: 'Budget, limits and approved suppliers.', go: 'card-rules' },
      { done: s.orders.length > 0, title: 'Run the purchasing agent', sub: 'Watch every decision. Undo any payment.', go: 'card-agent' },
    ];
    const show = local.get('mandate.welcome') !== 'closed' && !steps.every((x) => x.done);
    $('welcome').hidden = !show;
    if (!show) return;
    const now = steps.findIndex((x) => !x.done);
    $('steps').innerHTML = steps.map((x, i) => `<li class="${x.done ? 'done' : ''} ${i === now ? 'now' : ''}"><button type="button" data-go="${x.go}"><b>${esc(x.title)}</b><span>${esc(x.sub)}</span></button></li>`).join('');
  }

  function renderBudget(s) {
    const m = s.mandate;
    const cap = m.monthlyCap || 1;
    const paid = (m.openingSpend || 0) + s.totals.paid;
    $('month').textContent = new Date().toLocaleDateString('en-GB', { month: 'long' });
    $('spent').textContent = eur0(m.spent);
    $('cap').textContent = eur0(m.monthlyCap);
    const pct = (v) => `${Math.min(100, (v / cap) * 100)}%`;
    const meter = $('meter');
    meter.querySelector('.m-paid').style.width = pct(paid);
    meter.querySelector('.m-hold').style.width = pct(s.totals.held);
    meter.querySelector('.m-wait').style.width = pct(s.totals.waiting);
    meter.setAttribute('aria-label', `${eur0(m.spent)} of ${eur0(m.monthlyCap)} used this month`);
    $('t-paid').textContent = eur(paid);
    $('t-hold').textContent = eur(s.totals.held);
    $('t-wait').textContent = eur(s.totals.waiting);
    $('t-left').textContent = eur(Math.max(0, m.monthlyCap - m.spent));
  }

  function renderPayPal(s) {
    const m = s.mandate;
    const el = $('paypal-state');
    if (m.vaultId && !m.vaultBlocked) {
      el.innerHTML = `<div class="pp"><div class="pp-row"><div class="pp-logo" aria-hidden="true">P</div><div><b>PayPal saved for agents</b><span>${esc(m.vaultLabel)}</span></div></div>
        <p class="muted">Agents pay orders under ${eur0(m.autoApproveBelow)} on their own. Everything else waits for you.</p>
        <div class="row"><button class="btn btn-ghost btn-sm" id="disconnect" type="button">Remove</button></div></div>`;
      const d = $('disconnect');
      d.onclick = busy(d, () => api('POST', '/api/mandate/disconnect'));
    } else {
      el.innerHTML = `<div class="pp"><p class="muted">${m.vaultBlocked
        ? 'PayPal declined payments without you present, so every agent payment now waits for your approval.'
        : 'Save PayPal once so agents can pay small, in-policy orders without asking you. You approve this in PayPal.'}</p>
        <button class="btn btn-primary" id="connect" type="button">Save PayPal for agents</button></div>`;
      const c = $('connect');
      c.onclick = busy(c, async () => { const r = await api('POST', '/api/mandate/connect'); location.href = r.approveUrl; });
    }
  }

  const supName = (id) => ((state.suppliers.find((x) => x.id === id) || {}).name || id).replace(/ (BV|GmbH|Ltd|Wholesale)$/, '');
  const cap1 = (c) => c[0].toUpperCase() + c.slice(1);
  function renderRules(s) {
    const m = s.mandate;
    $('rules-text').textContent = m.plainText || 'No description yet.';
    const rows = [
      ['Monthly budget', eur0(m.monthlyCap)],
      ['Largest single order', eur0(m.perOrderCap)],
      ['Pays without asking below', eur0(m.autoApproveBelow)],
      ['Asks you if a price rises over', `${m.maxPriceIncreasePct}%`],
      ['Time to undo a payment', `${m.undoWindowSec} seconds`],
      ['Approved suppliers', m.allowedSupplierIds.map(supName).join(', ') || 'None'],
      ['Approved categories', m.allowedCategories.map(cap1).join(', ') || 'None'],
    ];
    $('rules').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('rules-version').textContent = `Version ${m.version || 1}. Every payment records the version that allowed it.`;
  }

  function renderAgents(s) {
    $('agents').innerHTML = (s.agents || []).map((a) => `<li>
      <div><b>${esc(a.name)}</b><div class="meta">${a.id === 'reorder-agent' ? 'Built in · runs on schedule' : 'External · connects with MCP'}</div></div>
      <input type="checkbox" class="switch" data-agent="${esc(a.id)}" ${a.active ? 'checked' : ''} aria-label="${esc(a.name)} may spend">
      <div class="bar"><i style="width:${Math.min(100, (a.spent / (a.monthlyCap || 1)) * 100)}%"></i></div>
      <span class="spent">${eur0(a.spent)} of ${eur0(a.monthlyCap)} this month${a.active ? '' : ' · paused'}</span></li>`).join('');
    document.querySelectorAll('[data-agent]').forEach((el) => {
      el.onchange = act(() => api('PATCH', `/api/agents/${el.dataset.agent}`, { active: el.checked }));
    });
  }

  function renderStock(s) {
    $('stock').innerHTML = s.stock.map((x) => {
      const reorderAt = x.leadTimeDays + 7;
      const low = x.coverDays < reorderAt;
      return `<li><span class="name" title="${esc(x.name)}">${esc(shortName(x.name))}</span><span class="days ${low ? 'low' : ''}">${Math.floor(x.coverDays)}</span>
        <div class="bar" title="Reorder when below ${reorderAt} days"><i class="${low ? 'low' : 'ok'}" style="width:${Math.min(100, (x.coverDays / 60) * 100)}%"></i></div></li>`;
    }).join('');
  }

  function issuesOf(o) {
    const issues = (o.checks || []).filter((c) => (o.decision === 'blocked' ? c.status === 'block' : c.status === 'review')).map((c) => c.detail);
    if (o.reasons.some((r) => r.code === 'VAULT_REFUSED')) issues.push('PayPal needs your approval.');
    return issues;
  }

  function renderInbox(s) {
    const waiting = s.orders.filter((o) => o.status === 'NEEDS_APPROVAL');
    $('card-inbox').hidden = waiting.length === 0;
    $('inbox-count').textContent = waiting.length ? `${waiting.length} · ${eur(waiting.reduce((a, o) => a + o.total, 0))}` : '';
    $('inbox').innerHTML = waiting.map((o) => `<li>
      <span class="what">${esc(o.supplierName)}</span>
      <div class="acts"><span class="amt">${eur(o.total)}</span>
        <button class="btn btn-primary btn-sm" data-approve="${esc(o.id)}" type="button">Approve in PayPal</button>
        <button class="btn btn-ghost btn-sm" data-reject="${esc(o.id)}" type="button">Decline</button></div>
      <span class="why">${esc(issuesOf(o)[0] || 'Needs your approval.')}</span>
      <span class="meta">${esc(o.createdBy)} · ${esc(linesText(o))} · <button class="btn-link" data-open="${esc(o.id)}" type="button">See why</button></span>
    </li>`).join('');
    wireOrderButtons($('inbox'));
  }

  function wireOrderButtons(root) {
    root.querySelectorAll('[data-approve]').forEach((b) => { b.onclick = busy(b, async () => { const r = await api('POST', `/api/orders/${b.dataset.approve}/approve`); location.href = r.approveUrl; }); });
    root.querySelectorAll('[data-reject]').forEach((b) => { b.onclick = busy(b, async () => { await api('POST', `/api/orders/${b.dataset.reject}/reject`); toast('Declined. Nothing was charged.'); }); });
    root.querySelectorAll('[data-undo]').forEach((b) => { b.onclick = busy(b, async () => { const o = await api('POST', `/api/orders/${b.dataset.undo}/undo`); toast(o.status === 'REFUNDED' ? 'Refunded through PayPal.' : 'Undone. No money moved.'); }); });
    root.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openDrawer(b.dataset.open); });
  }

  function renderLog(s) {
    $('log').innerHTML = s.audit.map((a) => `<li><time>${new Date(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time><span class="who" title="${esc(a.actor)}">${esc(a.actor)}</span><span>${esc(a.message)}</span></li>`).join('');
  }

  // ---------- payments grid (AG Grid) ----------
  const FILTERS = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'wait', label: 'Waiting for you', test: (o) => o.status === 'NEEDS_APPROVAL' },
    { id: 'hold', label: 'On hold', test: (o) => ['PAYING', 'AUTHORIZED', 'CAPTURING'].includes(o.status) },
    { id: 'paid', label: 'Paid', test: (o) => o.status === 'CAPTURED' },
    { id: 'blocked', label: 'Blocked', test: (o) => o.status === 'BLOCKED' || o.status === 'FAILED' },
    { id: 'undone', label: 'Undone', test: (o) => ['VOIDED', 'REFUNDED', 'REJECTED'].includes(o.status) },
  ];
  let filter = 'all';

  function actionsCell(p) {
    if (!p.data || p.node.rowPinned) return '';
    const o = p.data;
    const wrap = document.createElement('div');
    wrap.className = 'cell-acts';
    if (o.status === 'NEEDS_APPROVAL') wrap.innerHTML = `<button class="btn btn-primary" data-approve="${esc(o.id)}" type="button">Approve</button>`;
    else if (o.status === 'AUTHORIZED') wrap.innerHTML = `<button class="btn btn-danger" data-undo="${esc(o.id)}" type="button">Undo</button>`;
    else if (o.status === 'CAPTURED') wrap.innerHTML = `<button class="btn btn-ghost" data-undo="${esc(o.id)}" type="button">Refund</button>`;
    wrap.addEventListener('click', (e) => e.stopPropagation());
    wireOrderButtons(wrap);
    return wrap;
  }

  const grid = agGrid.createGrid($('grid'), {
    rowData: [],
    getRowId: (p) => p.data.id,
    domLayout: 'autoHeight',
    rowHeight: 48,
    headerHeight: 40,
    animateRows: true,
    overlayNoRowsTemplate: '<span class="muted">No payments yet. Run the agent to see how your rules decide.</span>',
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    isExternalFilterPresent: () => filter !== 'all',
    doesExternalFilterPass: (n) => FILTERS.find((f) => f.id === filter).test(n.data),
    columnDefs: [
      { field: 'supplierName', headerName: 'Supplier', flex: 1.2, minWidth: 150 },
      { headerName: 'What', flex: 1.6, minWidth: 180, valueGetter: (p) => (p.data.lines ? linesText(p.data) : ''), tooltipValueGetter: (p) => p.value },
      { field: 'createdBy', headerName: 'Agent', width: 140 },
      { field: 'total', headerName: 'Amount', width: 120, type: 'rightAligned', valueFormatter: (p) => eur(p.value) },
      { field: 'status', headerName: 'Status', width: 170, cellRenderer: (p) => (p.node.rowPinned ? '' : statusBadge(p.data)) },
      { headerName: '', colId: 'act', width: 110, sortable: false, resizable: false, cellRenderer: actionsCell },
    ],
    onRowClicked: (e) => { if (!e.node.rowPinned) openDrawer(e.data.id); },
    onCellKeyDown: (e) => { if (e.event.key === 'Enter' && e.data && !e.node.rowPinned) openDrawer(e.data.id); },
  });

  function pinTotals() {
    const rows = [];
    grid.forEachNodeAfterFilter((n) => rows.push(n.data));
    const live = rows.filter((o) => !DEAD.includes(o.status));
    grid.setGridOption('pinnedBottomRowData', rows.length
      ? [{ id: '__total', supplierName: `${rows.length} payment${rows.length > 1 ? 's' : ''}`, lines: null, createdBy: 'Active total', total: live.reduce((a, o) => a + o.total, 0), status: '' }]
      : []);
  }

  function renderGrid(s) {
    grid.setGridOption('rowData', s.orders);
    grid.refreshCells({ columns: ['status', 'act'], force: true });
    $('filters').innerHTML = FILTERS.map((f) => `<button type="button" role="tab" aria-selected="${f.id === filter}" data-f="${f.id}">${f.label}<span class="n">${s.orders.filter(f.test).length}</span></button>`).join('');
    $('filters').querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; grid.onFilterChanged(); renderGrid(state); }; });
    pinTotals();
  }
  $('search').addEventListener('input', (e) => { grid.setGridOption('quickFilterText', e.target.value); pinTotals(); });

  // ---------- payment drawer ----------
  let openId = null;
  let lastFocus = null;
  function openDrawer(id) {
    openId = id;
    lastFocus = document.activeElement;
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    renderDrawer();
    $('d-close').focus();
  }
  function closeDrawer() {
    if (!openId) return;
    openId = null;
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }
  $('d-close').onclick = closeDrawer;
  $('scrim').onclick = closeDrawer;

  function renderDrawer() {
    if (!openId || !state) return;
    const o = state.orders.find((x) => x.id === openId);
    if (!o) { closeDrawer(); return; }
    const rc = o.receipt || {};
    const d = DECISION[o.decision] || DECISION.auto;
    const checks = (o.checks || []).filter((c) => c.status !== 'skip');
    const issues = checks.filter((c) => (o.decision === 'blocked' ? c.status === 'block' : c.status === 'review'));
    const other = checks.filter((c) => c.status !== 'pass' && !issues.includes(c));
    const passed = checks.filter((c) => c.status === 'pass');
    const icon = { pass: '✓', review: '!', block: '✕' };
    const li = (c) => `<li class="${c.status}"><span class="i" aria-hidden="true">${icon[c.status]}</span><div>${esc(c.label)}<span class="d">${esc(c.detail)}</span></div></li>`;
    const vault = o.reasons.find((r) => r.code === 'VAULT_REFUSED');
    let actions = '';
    if (o.status === 'NEEDS_APPROVAL') actions = `<button class="btn btn-primary" data-approve="${esc(o.id)}" type="button">Approve in PayPal</button><button class="btn btn-ghost" data-reject="${esc(o.id)}" type="button">Decline</button>`;
    else if (o.status === 'AUTHORIZED') actions = `<button class="btn btn-danger" data-undo="${esc(o.id)}" type="button">Undo payment</button><span class="muted">PayPal holds the money for <span data-left="${esc(o.id)}">${secondsLeft(o)}s</span>. Nothing has gone to the supplier yet.</span>`;
    else if (o.status === 'CAPTURED') actions = `<button class="btn btn-ghost" data-undo="${esc(o.id)}" type="button">Refund payment</button>`;
    const refs = [['PayPal order', o.paypal.orderId], ['Authorization', o.paypal.authorizationId], ['Capture', o.paypal.captureId], ['Refund', o.paypal.refundId]].filter(([, v]) => v);

    $('d-eyebrow').textContent = `${o.id} · ${new Date(o.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    $('d-title').textContent = o.supplierName;
    $('d-body').innerHTML = `
      <div class="summary"><span class="amt">${eur(o.total)}</span>${statusBadge(o)}</div>
      ${actions ? `<div class="row">${actions}</div>` : ''}
      <div class="verdict ${esc(o.decision)}"><b>${d.title}</b>${d.text}</div>
      <div>
        <p class="section-title">Why your rules decided this</p>
        ${issues.length || vault ? `<ul class="checks">${issues.map(li).join('')}${vault ? `<li class="review"><span class="i">!</span><div>PayPal<span class="d">${esc(vault.message)}</span></div></li>` : ''}</ul>` : ''}
        ${other.length ? `<details class="passed-toggle"><summary class="btn-link">${other.length} other rule${other.length > 1 ? 's' : ''} also flagged</summary><ul class="checks">${other.map(li).join('')}</ul></details>` : ''}
        ${passed.length ? `<details class="passed-toggle" ${issues.length ? '' : 'open'}><summary class="btn-link">${passed.length} rule${passed.length > 1 ? 's' : ''} passed</summary><ul class="checks">${passed.map(li).join('')}</ul></details>` : ''}
      </div>
      ${rc.rationale ? `<div><p class="section-title">What the agent said</p><p class="rationale">${esc(rc.rationale)}</p></div>` : ''}
      <div>
        <p class="section-title">Items</p>
        <table class="lines"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>
        ${o.lines.map((l) => `<tr><td>${esc(l.name)}<span class="reason">${esc(l.reason)}</span></td><td class="r">${l.qty.toLocaleString('en')}</td><td class="r">${eur(l.lineTotal)}</td></tr>`).join('')}
        </tbody><tfoot><tr><td>Total</td><td></td><td class="r">${eur(o.total)}</td></tr></tfoot></table>
      </div>
      <div>
        <p class="section-title">Record</p>
        <dl class="refs"><dt>Requested by</dt><dd>${esc(rc.agentName || o.createdBy)}</dd><dt>Rules version</dt><dd>v${esc(rc.mandateVersion || 1)}</dd>${refs.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}${o.error ? `<dt>Error</dt><dd>${esc(o.error)}</dd>` : ''}</dl>
      </div>`;
    wireOrderButtons($('d-body'));
  }

  // ---------- modals ----------
  function openModal(id, focusId) {
    lastFocus = document.activeElement;
    $(id).hidden = false;
    setTimeout(() => (focusId ? $(focusId) : $(id).querySelector('button, textarea, input')).focus(), 30);
  }
  function closeModals() {
    let was = false;
    document.querySelectorAll('.modal').forEach((m) => { if (!m.hidden) was = true; m.hidden = true; });
    if (was && lastFocus && lastFocus.isConnected) lastFocus.focus();
  }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('tour').hidden) { endTour(); return; }
    if ([...document.querySelectorAll('.modal')].some((m) => !m.hidden)) { closeModals(); return; }
    closeDrawer();
  });
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const el = $(b.dataset.copy);
      try { await navigator.clipboard.writeText(el.textContent); toast('Copied.'); } catch {
        const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r);
      }
    };
  });

  // kill switch
  $('kill').onclick = () => {
    const open = state.orders.filter((o) => o.status === 'AUTHORIZED');
    const sum = open.reduce((a, o) => a + o.total, 0);
    $('kill-q').textContent = open.length
      ? `Every agent stops immediately, and ${open.length} payment${open.length > 1 ? 's' : ''} on hold (${eur(sum)}) will be cancelled in PayPal. Paid orders are not affected.`
      : 'Every agent stops immediately. Nothing is on hold right now, so no payment is cancelled.';
    openModal('m-kill', 'kill-confirm');
  };
  $('kill-confirm').onclick = busy($('kill-confirm'), async () => {
    const r = await api('POST', '/api/kill');
    closeModals();
    toast(`All agents stopped.${r.voided ? ` ${r.voided} payment${r.voided > 1 ? 's' : ''} cancelled in PayPal. No money moved.` : ''}`);
  });
  $('resume').onclick = busy($('resume'), async () => { await api('PUT', '/api/mandate', { active: true }); toast('Agents can spend again.'); });

  $('reset').onclick = busy($('reset'), async () => {
    await api('POST', '/api/reset');
    $('feed').innerHTML = '';
    $('feed-empty').hidden = false;
    closeDrawer();
    toast('Demo restarted with fresh data.');
  });

  // connect an agent
  $('connect-agent').onclick = () => {
    const cfg = { mcpServers: { mandate: { command: 'npx', args: ['-y', '-p', 'github:deepakkushwaha7/mandate-paypal-agent', 'mandate-mcp'], env: { MANDATE_URL: location.origin, MANDATE_AGENT_ID: 'claude-desktop', MANDATE_AGENT_KEY: state.agentKey } } } };
    $('mcp-config').textContent = JSON.stringify(cfg, null, 2);
    $('toolkit-snippet').textContent = [
      "const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');",
      "const { guardToolkit } = require('./examples/paypal-agent-toolkit-guard');",
      '',
      'const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration });',
      'const guarded = guardToolkit(toolkit, {',
      "  agentId: 'claude-desktop',",
      `  mandateUrl: '${location.origin}',`,
      `  agentKey: '${state.agentKey}',`,
      '});',
      '',
      '// Same API as the toolkit. Refunds, invoices and orders are checked first.',
      'await guarded.handleToolCall(toolCall);',
    ].join('\n');
    openModal('m-connect');
  };

  // ---------- rules editor ----------
  function fillForm() {
    const m = state.mandate;
    $('plain').value = m.plainText || '';
    $('f-monthly').value = m.monthlyCap;
    $('f-perorder').value = m.perOrderCap;
    $('f-auto').value = m.autoApproveBelow;
    $('f-drift').value = m.maxPriceIncreasePct;
    $('f-undo').value = m.undoWindowSec;
    $('f-suppliers').innerHTML = state.suppliers.map((s) => `<label><input type="checkbox" value="${esc(s.id)}" ${m.allowedSupplierIds.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');
    const cats = [...new Set(state.stock.map((x) => x.category))];
    $('f-cats').innerHTML = cats.map((c) => `<label><input type="checkbox" value="${esc(c)}" ${m.allowedCategories.includes(c) ? 'checked' : ''}> ${esc(cap1(c))}</label>`).join('');
    $('diff').innerHTML = '';
    $('parse-status').textContent = '';
  }
  $('edit-rules').onclick = () => { fillForm(); openModal('m-rules', 'plain'); };
  $('parse').onclick = busy($('parse'), async () => {
    const text = $('plain').value.trim();
    $('parse-status').textContent = state.mode.ai ? `${state.mode.ai.label} is reading your rules…` : 'Reading your rules…';
    try {
      const r = await api('POST', '/api/mandate/parse', { text });
      const fallback = r.engineError ? '<p class="warn">AI was unavailable, so a simpler reader was used. Please check the changes.</p>' : '';
      if (!r.changes.length) {
        $('diff').innerHTML = `<p class="muted">No changes. Your rules already say this.</p>${fallback}`;
        return;
      }
      $('diff').innerHTML = `<table><thead><tr><th>Rule</th><th>Now</th><th>After</th></tr></thead><tbody>
        ${r.changes.map((c) => `<tr><td>${esc(c.label)}</td><td class="from">${esc(c.from)}</td><td class="to">${esc(c.to)}</td></tr>`).join('')}</tbody></table>
        ${r.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}${fallback}
        <div class="row"><button class="btn btn-primary" id="apply" type="button">Apply ${r.changes.length} change${r.changes.length > 1 ? 's' : ''}</button><span class="muted">Read by ${r.engine === 'rules' ? 'the built-in reader' : esc(r.engine)}. Nothing changes until you apply.</span></div>`;
      $('apply').onclick = busy($('apply'), async () => {
        await api('PUT', '/api/mandate', { ...r.proposed, plainText: text });
        closeModals();
        toast('Rules updated. Agents use them from their next purchase.');
      });
    } finally {
      $('parse-status').textContent = '';
    }
  });
  $('rules-form').onsubmit = act(async (e) => {
    e.preventDefault();
    const checked = (id) => [...$(id).querySelectorAll('input:checked')].map((i) => i.value);
    await api('PUT', '/api/mandate', {
      monthlyCap: $('f-monthly').value, perOrderCap: $('f-perorder').value, autoApproveBelow: $('f-auto').value,
      maxPriceIncreasePct: $('f-drift').value, undoWindowSec: $('f-undo').value,
      allowedSupplierIds: checked('f-suppliers'), allowedCategories: checked('f-cats'),
    });
    closeModals();
    toast('Rules saved.');
  });

  // ---------- agent run ----------
  document.querySelectorAll('#chips .chip').forEach((b) => { b.onclick = () => { $('instruction').value = b.textContent; $('instruction').focus(); }; });
  $('run-form').onsubmit = act(async (e) => {
    e.preventDefault();
    $('feed').innerHTML = '';
    $('feed-empty').hidden = true;
    await api('POST', '/api/agent/run', { instruction: $('instruction').value.trim() });
  });

  // Model text may contain light Markdown (**bold**, line breaks, numbered
  // lists). Escape first, then allow only bold and line breaks.
  const richText = (text) => esc(String(text).trim()).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n+/g, '<br>');

  function addStep(t) {
    if (t.kind === 'done' || t.kind === 'start') return;
    $('feed-empty').hidden = true;
    const li = document.createElement('li');
    let cls = '';
    let ic = '•';
    let html = esc(t.text);
    if (t.kind === 'thought') { cls = 'think'; ic = 'AI'; html = richText(t.text); }
    if (t.kind === 'tool') { ic = '↻'; html = `<span class="muted">${esc(t.text)}</span>`; }
    if (t.kind === 'proposal') {
      cls = t.decision;
      ic = { auto: '✓', needs_approval: '!', blocked: '✕' }[t.decision];
      const label = { auto: 'Paid automatically.', needs_approval: 'Needs your OK.', blocked: 'Blocked.' }[t.decision];
      const issue = (t.checks || []).filter((c) => (t.decision === 'blocked' ? c.status === 'block' : c.status === 'review')).map((c) => c.detail);
      html = `<span class="who">${label}</span>${esc(t.text)}${issue.length ? `<div class="why">${esc(issue.join(' '))}</div>` : ''}`;
    }
    if (t.kind === 'finish') { cls = 'finish'; ic = '✓'; html = `<span class="who">Summary.</span> ${richText(t.text)}`; }
    if (t.kind === 'error') { cls = 'blocked'; ic = '✕'; }
    li.className = cls;
    li.innerHTML = `<span class="ic" aria-hidden="true">${ic}</span><div class="body">${html}</div>`;
    $('feed').appendChild(li);
    $('feed').scrollTop = $('feed').scrollHeight;
  }

  // ---------- toasts ----------
  function toast(text, { error = false, action = null, ms = 6000 } = {}) {
    const t = document.createElement('div');
    t.className = `toast${error ? ' err' : ''}`;
    t.setAttribute('role', error ? 'alert' : 'status');
    const body = document.createElement('div');
    body.textContent = text;
    t.appendChild(body);
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm';
      b.type = 'button';
      b.textContent = action.label;
      b.onclick = busy(b, async () => { await action.run(); t.remove(); });
      t.appendChild(b);
    }
    $('toasts').appendChild(t);
    if (ms) setTimeout(() => t.remove(), ms);
    return t;
  }
  const seenHolds = new Set();
  let firstRender = true;
  function toastNewHolds(orders) {
    for (const o of orders) {
      if (o.status !== 'AUTHORIZED' || seenHolds.has(o.id)) continue;
      seenHolds.add(o.id);
      if (firstRender) continue;
      const t = toast(`${o.createdBy} paid ${eur(o.total)} to ${o.supplierName}.`, {
        ms: 0,
        action: { label: 'Undo', run: async () => { await api('POST', `/api/orders/${o.id}/undo`); toast('Undone. No money moved.'); } },
      });
      const small = document.createElement('small');
      t.firstChild.appendChild(small);
      const tick = () => {
        const cur = state.orders.find((x) => x.id === o.id);
        const left = cur ? secondsLeft(cur) : 0;
        if (!cur || cur.status !== 'AUTHORIZED' || left <= 0) { t.remove(); clearInterval(iv); return; }
        small.textContent = `On hold in PayPal · undo within ${left}s`;
      };
      const iv = setInterval(tick, 1000);
      tick();
    }
    firstRender = false;
  }
  setInterval(() => {
    if (!state) return;
    document.querySelectorAll('[data-left]').forEach((el) => {
      const o = state.orders.find((x) => x.id === el.dataset.left);
      if (o) el.textContent = `${secondsLeft(o)}s`;
    });
  }, 1000);

  // ---------- guided tour ----------
  const TOUR = [
    { el: null, title: 'Welcome to Mandate', text: 'AI agents are starting to buy things for businesses. Mandate lets them pay through PayPal, but only within rules you set, with every payment explained and undoable. This demo uses the PayPal sandbox and fake money.' },
    { el: 'card-paypal', title: 'Save PayPal once', text: 'You approve in PayPal one time. After that, agents can pay small orders without you, like a company card with your rules attached.' },
    { el: 'card-rules', title: 'Your rules', text: 'Budget, largest order, what can be paid without asking, approved suppliers. Write them in plain English and AI turns them into exact rules. You see every change before it applies.' },
    { el: 'card-agent', title: 'Run the agent', text: 'The agent checks stock and proposes orders. AI suggests, but plain code checks every order against your rules. Try the Black Friday example.' },
    { el: 'card-payments', title: 'Every payment, explained', text: 'Small orders are paid but held by PayPal for a minute, so you can undo them. Anything unusual waits for you. Click a payment to see exactly which rule decided.' },
    { el: 'card-agents', title: 'Any agent, same rules', text: 'Connect Claude Desktop or any agent through MCP, or wrap PayPal’s own Agent Toolkit. Each agent has its own budget and can never change your rules.' },
    { el: 'kill', title: 'One button stops everything', text: 'Stops every agent and cancels every payment still on hold in PayPal.' },
  ];
  let tourAt = 0;
  let tourTimer = null;
  function placeTour() {
    const step = TOUR[tourAt];
    $('tour-step').textContent = `Step ${tourAt + 1} of ${TOUR.length}`;
    $('tour-title').textContent = step.title;
    $('tour-text').textContent = step.text;
    $('tour-back').hidden = tourAt === 0;
    $('tour-next').textContent = tourAt === TOUR.length - 1 ? 'Finish' : 'Next';
    const hole = $('tour-hole');
    const pop = $('tour-pop');
    const target = step.el && $(step.el);
    const w = Math.min(360, innerWidth - 32);
    clearTimeout(tourTimer);
    if (!target || target.offsetParent === null) {
      hole.style.cssText = `top:${innerHeight / 2}px;left:${innerWidth / 2}px;width:0;height:0;`;
      pop.style.top = `${Math.max(16, innerHeight / 2 - 120)}px`;
      pop.style.left = `${Math.max(16, (innerWidth - w) / 2)}px`;
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    tourTimer = setTimeout(() => {
      const r = target.getBoundingClientRect();
      const pad = 8;
      hole.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`;
      let left;
      let top;
      if (r.right + 16 + w < innerWidth) { left = r.right + 16; top = r.top; }
      else if (r.left - 16 - w > 0) { left = r.left - 16 - w; top = r.top; }
      else { left = Math.min(innerWidth - w - 16, Math.max(16, r.left)); top = r.bottom + 16; }
      if (top + 240 > innerHeight) top = Math.max(16, innerHeight - 256);
      pop.style.top = `${Math.max(16, top)}px`;
      pop.style.left = `${left}px`;
    }, 380);
  }
  function startTour() {
    tourAt = 0;
    closeDrawer();
    closeModals();
    $('tour').hidden = false;
    placeTour();
    $('tour-next').focus();
  }
  function endTour() {
    $('tour').hidden = true;
    local.set('mandate.tour', 'done');
  }
  $('tour-next').onclick = () => { if (tourAt === TOUR.length - 1) { endTour(); return; } tourAt += 1; placeTour(); };
  $('tour-back').onclick = () => { tourAt = Math.max(0, tourAt - 1); placeTour(); };
  $('tour-skip').onclick = endTour;
  addEventListener('resize', () => { if (!$('tour').hidden) placeTour(); });
  $('tour-btn').onclick = startTour;
  $('welcome-tour').onclick = startTour;
  $('welcome-close').onclick = () => { local.set('mandate.welcome', 'closed'); render(); };
  $('steps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    const t = $(b.dataset.go);
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = t.querySelector('button, input');
    if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 400);
  });

  // ---------- live updates ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      state = JSON.parse(e.data);
      skew = new Date(state.serverTime) - Date.now();
      render();
    });
    es.addEventListener('trace', (e) => addStep(JSON.parse(e.data)));
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }
  connect();
})();
