/* global agGrid */
(() => {
  const $ = (id) => document.getElementById(id);
  const eur = (n) => '€' + Number(n || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS_LABEL = {
    PAYING: 'Paying', AUTHORIZED: 'Held · undo', CAPTURING: 'Capturing', CAPTURED: 'Paid', NEEDS_APPROVAL: 'Needs you',
    BLOCKED: 'Blocked', FAILED: 'Failed', VOIDED: 'Undone', REFUNDED: 'Refunded', REJECTED: 'Rejected',
  };

  let state = null;
  let skew = 0;
  let selectedId = null;
  let editing = false;

  // ---------- notices ----------
  function notice(text, isError) {
    const n = $('notice');
    n.textContent = text;
    n.className = 'notice' + (isError ? ' err' : '');
    n.hidden = false;
    clearTimeout(notice.t);
    notice.t = setTimeout(() => (n.hidden = true), 7000);
  }
  const params = new URLSearchParams(location.search);
  const NOTICES = {
    'paypal-connected': 'PayPal saved. The agent can now pay within your mandate without asking.',
    'paypal-cancelled': 'PayPal was not saved. Agent orders will wait for your approval.',
    approved: `Approved in PayPal. ${params.get('order') || 'The order'} is authorized, and you can undo it until the window closes.`,
    'approval-cancelled': 'Approval cancelled. The order is still waiting for you.',
  };
  if (params.get('notice') && NOTICES[params.get('notice')]) {
    notice(NOTICES[params.get('notice')]);
    history.replaceState(null, '', '/');
  }

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }
  const act = (fn) => async (...a) => {
    try { await fn(...a); } catch (e) { notice(e.message, true); }
  };

  // ---------- grid ----------
  const secondsLeft = (o) => (o.undoUntil ? Math.max(0, Math.ceil((new Date(o.undoUntil) - (Date.now() + skew)) / 1000)) : 0);

  function actionsRenderer(p) {
    const o = p.data;
    const wrap = document.createElement('div');
    wrap.className = 'cell-actions';
    const add = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); act(fn)(); });
      wrap.appendChild(b);
    };
    if (o.status === 'NEEDS_APPROVAL') {
      add('Approve in PayPal', 'pp-btn', async () => {
        const r = await api('POST', `/api/orders/${o.id}/approve`);
        location.href = r.approveUrl;
      });
      add('Reject', 'ghost', () => api('POST', `/api/orders/${o.id}/reject`));
    } else if (o.status === 'AUTHORIZED') {
      const b = document.createElement('button');
      b.className = 'btn danger';
      b.dataset.undo = o.id;
      b.textContent = `Undo · ${secondsLeft(o)}s`;
      b.addEventListener('click', (e) => { e.stopPropagation(); act(() => api('POST', `/api/orders/${o.id}/undo`))(); });
      wrap.appendChild(b);
    } else if (o.status === 'CAPTURED') {
      add('Undo · refund', 'ghost', () => api('POST', `/api/orders/${o.id}/undo`));
    }
    return wrap;
  }

  const grid = agGrid.createGrid($('grid'), {
    rowData: [],
    getRowId: (p) => p.data.id,
    rowHeight: 44,
    rowSelection: 'single',
    animateRows: true,
    overlayNoRowsTemplate: '<span style="color:var(--muted)">No orders yet. Run the agent to start.</span>',
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    columnDefs: [
      { field: 'id', headerName: 'PO', width: 100, cellClass: 'mono' },
      { field: 'createdAt', headerName: 'Created', width: 95, sort: 'desc', valueFormatter: (p) => new Date(p.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
      { field: 'supplierName', headerName: 'Supplier', flex: 1, minWidth: 150 },
      { headerName: 'Lines', flex: 1.4, minWidth: 180, valueGetter: (p) => p.data.lines.map((l) => `${l.qty.toLocaleString('en')} × ${l.sku}`).join(', ') },
      { field: 'total', headerName: 'Total', width: 110, type: 'rightAligned', cellClass: 'mono', valueFormatter: (p) => eur(p.value) },
      { field: 'createdBy', headerName: 'By', width: 80 },
      { field: 'status', headerName: 'Status', width: 130, cellRenderer: (p) => `<span class="status s-${p.value}">${STATUS_LABEL[p.value] || p.value}</span>` },
      { headerName: '', colId: 'actions', minWidth: 210, flex: 1, sortable: false, cellRenderer: actionsRenderer },
    ],
    onRowClicked: (e) => { selectedId = e.data.id; renderDetail(); },
  });

  // ---------- render ----------
  function render() {
    if (!state) return;
    const s = state;
    $('company').textContent = `${s.company.name} · ${s.company.buyer}`;
    $('modes').innerHTML =
      `<span class="pill ${s.mode.paypal === 'simulated' ? 'sim' : ''}">PayPal: ${s.mode.paypal}</span>` +
      `<span class="pill ${s.mode.agent === 'rules' ? 'sim' : ''}">Agent: ${s.mode.agent === 'claude' ? esc(s.mode.model) : 'rules planner'}</span>`;
    $('engine').textContent = s.mode.agent === 'claude' ? `Claude (${s.mode.model}) with tool use` : 'Deterministic planner (add ANTHROPIC_API_KEY for Claude)';

    // budget
    const m = s.mandate;
    const cap = m.monthlyCap || 1;
    const paid = m.openingSpend + s.totals.paid;
    $('month').textContent = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    $('spent').textContent = eur(m.spent);
    $('cap').textContent = eur(m.monthlyCap);
    const pct = (v) => Math.min(100, (v / cap) * 100) + '%';
    $('meter').querySelector('.m-spent').style.width = pct(paid);
    $('meter').querySelector('.m-held').style.width = pct(s.totals.held);
    $('meter').querySelector('.m-wait').style.width = pct(s.totals.waiting);
    $('t-paid').textContent = eur(paid);
    $('t-held').textContent = eur(s.totals.held);
    $('t-wait').textContent = eur(s.totals.waiting);
    $('t-left').textContent = eur(m.monthlyCap - m.spent);

    // mandate
    $('pp').innerHTML = m.vaultId
      ? `<p><b>PayPal saved</b> · ${esc(m.vaultLabel)}<br><span class="muted">The agent pays orders below ${eur(m.autoApproveBelow)} on its own. Larger or unusual orders wait for you.</span></p><button class="btn ghost small" id="disconnect">Remove</button>`
      : `<p><b>No payment method yet.</b><br><span class="muted">Save PayPal once so the agent can pay small, in-policy orders without asking you.</span></p><button class="btn pp-btn" id="connect">Save PayPal for the agent</button>`;
    const c = $('connect');
    if (c) c.onclick = act(async () => { c.disabled = true; const r = await api('POST', '/api/mandate/connect'); location.href = r.approveUrl; });
    const d = $('disconnect');
    if (d) d.onclick = act(() => api('POST', '/api/mandate/disconnect'));
    const supName = (id) => (s.suppliers.find((x) => x.id === id) || {}).name || id;
    $('rules').innerHTML = [
      [m.active ? 'Active' : 'Paused', 'agent spending'],
      [eur(m.perOrderCap), 'max per order'],
      [eur(m.autoApproveBelow), 'auto-pay below'],
      [`${m.maxPriceIncreasePct}%`, 'max supplier price rise'],
      [`${m.undoWindowSec}s`, 'undo window before capture'],
      [m.allowedCategories.join(', '), 'allowed categories'],
      [m.allowedSupplierIds.map(supName).join(', '), 'allowed suppliers'],
    ].map(([b, t]) => `<li><b>${esc(b)}</b><span>${esc(t)}</span></li>`).join('');
    if (!editing) fillForm();
    $('mversion').textContent = `version ${m.version || 1}`;
    const pt = $('plain-text');
    if (document.activeElement !== pt && !pt.dataset.dirty) pt.value = m.plainText || '';

    // kill switch and paused banner
    const kill = $('kill');
    kill.textContent = m.active ? 'Stop all agents' : 'Resume agents';
    kill.classList.toggle('off', !m.active);
    let banner = $('paused');
    if (!m.active && !banner) {
      banner = document.createElement('div');
      banner.id = 'paused';
      banner.className = 'paused-banner';
      banner.textContent = 'All agents are stopped. No agent can spend until you resume.';
      document.querySelector('.layout').before(banner);
    } else if (m.active && banner) banner.remove();

    // agents
    $('agent-list').innerHTML = (s.agents || []).map((a) => `<li>
      <div><b>${esc(a.name)}</b><div class="meta">${esc(a.kind)}</div></div>
      <input type="checkbox" class="switch" data-agent="${esc(a.id)}" ${a.active ? 'checked' : ''} aria-label="${esc(a.name)} may spend">
      <span class="bar"><i style="width:${Math.min(100, (a.spent / (a.monthlyCap || 1)) * 100)}%"></i></span>
      <span class="spent">${eur(a.spent)} of ${eur(a.monthlyCap)} this month</span></li>`).join('');
    document.querySelectorAll('[data-agent]').forEach((el) => (el.onchange = act(() => api('PATCH', `/api/agents/${el.dataset.agent}`, { active: el.checked }))));
    $('mcp-config').textContent = JSON.stringify({ mcpServers: { mandate: { command: 'node', args: ['/path/to/mandate/src/mcp.js'], env: { MANDATE_URL: location.origin, MANDATE_AGENT_ID: 'claude-desktop' } } } }, null, 2);
    toastNew(s.orders);

    // run button
    $('run').disabled = s.running;
    $('run').textContent = s.running ? 'Agent is working…' : 'Run reorder check';

    // stock
    $('cover').innerHTML = s.stock.map((x) => {
      const reorderAt = x.leadTimeDays + 7;
      const scale = 60;
      const low = x.coverDays < reorderAt;
      return `<li><span class="name" title="${esc(x.name)}"><b class="mono">${esc(x.sku)}</b> · ${esc(x.supplierName)}</span><span class="days">${x.coverDays.toFixed(1)} d</span>
        <span class="bar"><i class="${low ? 'low' : ''}" style="width:${Math.min(100, (x.coverDays / scale) * 100)}%"></i><b style="left:${Math.min(100, (reorderAt / scale) * 100)}%" title="Reorder point ${reorderAt} days"></b></span></li>`;
    }).join('');

    // orders
    grid.setGridOption('rowData', s.orders);
    grid.refreshCells({ columns: ['actions', 'status'], force: true });
    $('order-count').textContent = `${s.orders.length} orders`;
    renderDetail();

    // audit
    $('audit').innerHTML = s.audit.map((a) =>
      `<li><time>${new Date(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span class="who">${esc(a.actor)}</span><span>${esc(a.message)}</span></li>`).join('');
  }

  function renderDetail() {
    const el = $('detail');
    const o = state && state.orders.find((x) => x.id === selectedId);
    if (!o) { el.hidden = true; return; }
    el.hidden = false;
    const ICON = { pass: '✓', review: '!', block: '✕', skip: '–' };
    const extra = o.reasons.filter((r) => r.code === 'VAULT_REFUSED').map((r) => `<li class="review"><span class="ic">!</span><div><b>PayPal</b> <span class="d">${esc(r.message)}</span></div></li>`).join('');
    const reasons = o.checks
      ? `<ul class="checks">${o.checks.map((c) => `<li class="${c.status}"><span class="ic">${ICON[c.status]}</span><div><b>${esc(c.label)}</b> <span class="d">${esc(c.detail)}</span></div></li>`).join('')}${extra}</ul>`
      : `<ul class="reasons">${o.reasons.map((r) => `<li class="${r.severity}">${esc(r.message)}</li>`).join('') || '<li class="ok">Within every limit of the mandate.</li>'}</ul>`;
    const rc = o.receipt || {};
    el.innerHTML = `
      <div>
        <h3>${esc(o.id)} · ${esc(o.supplierName)} <span class="status s-${o.status}">${STATUS_LABEL[o.status] || o.status}</span></h3>
        <p class="muted">${esc(o.note)}</p>
        <div style="overflow-x:auto"><table><thead><tr><th>SKU</th><th>Why</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Line</th></tr></thead><tbody>
        ${o.lines.map((l) => `<tr><td class="mono">${esc(l.sku)}</td><td>${esc(l.reason)}</td><td class="num">${l.qty.toLocaleString('en')}</td><td class="num">€${l.unitPrice}</td><td class="num">${eur(l.lineTotal)}</td></tr>`).join('')}
        <tr><td colspan="4"><b>Total</b></td><td class="num"><b>${eur(o.total)}</b></td></tr></tbody></table></div>
      </div>
      <div>
        <h3>Decision receipt: ${esc({ auto: 'paid automatically', needs_approval: 'needs a human', blocked: 'blocked' }[o.decision] || o.decision)}</h3>
        <div class="receipt-meta"><span>${esc(rc.agentName || o.createdBy)}</span><span>mandate v${esc(rc.mandateVersion || 1)}</span><span>${rc.evaluatedAt ? new Date(rc.evaluatedAt).toLocaleString('en-GB') : ''}</span></div>
        ${rc.rationale ? `<div class="rationale"><span class="eyebrow">Agent's reason</span><br>${esc(rc.rationale)}</div>` : ''}
        ${reasons}
        <div class="ids">
          ${o.paypal.orderId ? `<span>PayPal order ${esc(o.paypal.orderId)}</span>` : ''}
          ${o.paypal.authorizationId ? `<span>Authorization ${esc(o.paypal.authorizationId)}</span>` : ''}
          ${o.paypal.captureId ? `<span>Capture ${esc(o.paypal.captureId)}</span>` : ''}
          ${o.paypal.refundId ? `<span>Refund ${esc(o.paypal.refundId)}</span>` : ''}
          ${o.error ? `<span style="color:var(--bad)">${esc(o.error)}</span>` : ''}
        </div>
      </div>`;
  }

  // ---------- mandate form ----------
  function fillForm() {
    const m = state.mandate;
    $('f-monthly').value = m.monthlyCap;
    $('f-perorder').value = m.perOrderCap;
    $('f-auto').value = m.autoApproveBelow;
    $('f-drift').value = m.maxPriceIncreasePct;
    $('f-undo').value = m.undoWindowSec;
    $('f-active').checked = m.active;
    $('f-suppliers').innerHTML = state.suppliers.map((s) =>
      `<label><input type="checkbox" value="${esc(s.id)}" ${m.allowedSupplierIds.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');
    const cats = [...new Set(state.stock.map((x) => x.category))];
    $('f-cats').innerHTML = cats.map((c) =>
      `<label><input type="checkbox" value="${esc(c)}" ${m.allowedCategories.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('');
  }
  $('edit-mandate').onclick = () => { editing = true; fillForm(); $('mandate-form').hidden = false; $('rules').hidden = true; };
  $('cancel-mandate').onclick = () => { editing = false; $('mandate-form').hidden = true; $('rules').hidden = false; };
  $('mandate-form').onsubmit = act(async (e) => {
    e.preventDefault();
    const checked = (id) => [...$(id).querySelectorAll('input:checked')].map((i) => i.value);
    await api('PUT', '/api/mandate', {
      monthlyCap: $('f-monthly').value, perOrderCap: $('f-perorder').value, autoApproveBelow: $('f-auto').value,
      maxPriceIncreasePct: $('f-drift').value, undoWindowSec: $('f-undo').value, active: $('f-active').checked,
      allowedSupplierIds: checked('f-suppliers'), allowedCategories: checked('f-cats'),
    });
    editing = false;
    $('mandate-form').hidden = true;
    $('rules').hidden = false;
    notice('Mandate saved. The agent uses the new limits on its next run.');
  });

  // ---------- plain-English mandate ----------
  $('plain-text').addEventListener('input', (e) => (e.target.dataset.dirty = '1'));
  $('parse').onclick = act(async () => {
    const text = $('plain-text').value.trim();
    $('parse-status').textContent = 'Reading your mandate…';
    $('parse').disabled = true;
    try {
      const r = await api('POST', '/api/mandate/parse', { text });
      const box = $('diff');
      box.hidden = false;
      if (!r.changes.length) {
        box.innerHTML = '<div class="foot">No changes. Your mandate already says this.</div>';
        $('parse-status').textContent = '';
        return;
      }
      box.innerHTML = `<div style="overflow-x:auto"><table><thead><tr><th>Rule</th><th>Now</th><th>After</th></tr></thead><tbody>
        ${r.changes.map((c) => `<tr><td>${esc(c.label)}</td><td class="from">${esc(c.from)}</td><td class="to">${esc(c.to)}</td></tr>`).join('')}</tbody></table></div>
        ${r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
        <div class="foot"><button class="btn small" id="apply">Apply ${r.changes.length} change${r.changes.length > 1 ? 's' : ''}</button><button class="btn ghost small" id="discard">Discard</button><span class="muted">Read by ${r.engine === 'claude' ? 'Claude' : 'the rules parser'}. Nothing changes until you apply.</span></div>`;
      $('parse-status').textContent = '';
      $('apply').onclick = act(async () => {
        await api('PUT', '/api/mandate', { ...r.proposed, plainText: text });
        delete $('plain-text').dataset.dirty;
        box.hidden = true;
        notice('Mandate updated. Agents use the new rules from their next purchase.');
      });
      $('discard').onclick = () => { box.hidden = true; delete $('plain-text').dataset.dirty; render(); };
    } finally {
      $('parse').disabled = false;
      if ($('parse-status').textContent === 'Reading your mandate…') $('parse-status').textContent = '';
    }
  });

  $('kill').onclick = act(async () => {
    if (state.mandate.active) {
      const r = await api('POST', '/api/kill');
      notice(`All agents stopped.${r.voided ? ` ${r.voided} open PayPal authorization${r.voided > 1 ? 's' : ''} voided.` : ''}`, true);
    } else {
      await api('PUT', '/api/mandate', { active: true });
      notice('Agents resumed.');
    }
  });

  $('copy-mcp').onclick = async () => {
    try { await navigator.clipboard.writeText($('mcp-config').textContent); notice('MCP config copied.'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('mcp-config')); getSelection().removeAllRanges(); getSelection().addRange(r); }
  };

  // ---------- toasts: every new agent payment gets an Undo ----------
  const seenAuth = new Set();
  let firstState = true;
  function toastNew(list) {
    for (const o of list) {
      if (o.status !== 'AUTHORIZED' || seenAuth.has(o.id)) continue;
      seenAuth.add(o.id);
      if (firstState) continue;
      const t = document.createElement('div');
      t.className = 'toast';
      t.innerHTML = `<div>${esc(o.createdBy)} paid ${eur(o.total)} to ${esc(o.supplierName)}<small data-left></small></div><button class="btn">Undo</button>`;
      t.querySelector('button').onclick = act(async () => { await api('POST', `/api/orders/${o.id}/undo`); t.remove(); notice(`${o.id} undone. No money moved.`); });
      $('toasts').appendChild(t);
      const tick = () => {
        const cur = state.orders.find((x) => x.id === o.id);
        const left = cur ? secondsLeft(cur) : 0;
        if (!cur || cur.status !== 'AUTHORIZED' || left <= 0) { t.remove(); clearInterval(iv); return; }
        t.querySelector('[data-left]').textContent = `Undo open for ${left}s`;
      };
      const iv = setInterval(tick, 1000);
      tick();
    }
    firstState = false;
  }

  // ---------- agent ----------
  document.querySelectorAll('#chips .chip').forEach((b) => (b.onclick = () => ($('instruction').value = b.textContent)));
  $('run-form').onsubmit = act(async (e) => {
    e.preventDefault();
    $('trace').innerHTML = '';
    await api('POST', '/api/agent/run', { instruction: $('instruction').value.trim() });
  });

  const KIND = { start: 'Start', tool: 'Reads', thought: 'Thinks', proposal: 'Proposes', finish: 'Summary', error: 'Error' };
  function addTrace(t) {
    if (t.kind === 'done') return;
    const li = document.createElement('li');
    let cls = t.kind;
    let label = KIND[t.kind] || t.kind;
    let extra = '';
    if (t.kind === 'proposal') {
      cls += ' ' + t.decision;
      label = { auto: 'Auto-pay', needs_approval: 'Needs you', blocked: 'Blocked' }[t.decision];
      if (t.reasons && t.reasons.length) extra = `<ul>${t.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>`;
      if (t.checks) {
        const passed = t.checks.filter((c) => c.status === 'pass').length;
        extra += `<div class="chipline"><span>${passed}/${t.checks.filter((c) => c.status !== 'skip').length} rules passed</span>${t.checks.filter((c) => c.status === 'review' || c.status === 'block').map((c) => `<span class="${c.status}">${esc(c.label)}</span>`).join('')}</div>`;
      }
    }
    if (t.kind === 'start') label = t.engine === 'claude' ? 'Claude' : 'Planner';
    li.className = cls;
    li.innerHTML = `<span class="k">${esc(label)}</span><div>${esc(t.text)}${extra}</div>`;
    const list = $('trace');
    const empty = list.querySelector('.empty');
    if (empty) empty.remove();
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }

  $('reset').onclick = act(async () => {
    await api('POST', '/api/reset');
    selectedId = null;
    $('trace').innerHTML = '<li class="empty">The agent\'s reasoning and every mandate decision appear here.</li>';
    notice('Demo data reset.');
  });

  // ---------- live updates ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      state = JSON.parse(e.data);
      skew = new Date(state.serverTime) - Date.now();
      render();
    });
    es.addEventListener('trace', (e) => addTrace(JSON.parse(e.data)));
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }
  connect();

  setInterval(() => {
    document.querySelectorAll('[data-undo]').forEach((b) => {
      const o = state && state.orders.find((x) => x.id === b.dataset.undo);
      if (o) b.textContent = `Undo · ${secondsLeft(o)}s`;
    });
  }, 1000);
})();
