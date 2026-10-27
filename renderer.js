const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let tabs = [];
let activeId = null;
let net = new Map();
let selected = null;
let srcMode = 'raw';
let srcData = null;
let wasLoading = false;
let panelTab = 'src';

// ---------- tabs + toolbar ----------
function renderTabs() {
  const el = $('#tabs');
  el.innerHTML =
    tabs
      .map(
        (t) => `<div class="tab ${t.id === activeId ? 'on' : ''}" data-id="${t.id}">
          ${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : ''}
          <span>${esc(t.title || t.url || 'New tab')}</span>
          <button class="x" data-close="${t.id}" aria-label="Close tab">×</button>
        </div>`
      )
      .join('') + '<button id="add" aria-label="New tab">+</button>';
}

$('#tabs').addEventListener('click', (e) => {
  if (e.target.id === 'add') return api.newTab();
  const close = e.target.closest('[data-close]');
  if (close) return api.closeTab(Number(close.dataset.close));
  const tab = e.target.closest('.tab');
  if (tab) api.activateTab(Number(tab.dataset.id));
});

$('#back').onclick = () => api.back();
$('#fwd').onclick = () => api.forward();
$('#reload').onclick = () => api.reload();
$('#url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { api.go(e.target.value); e.target.blur(); }
});
$('#url').addEventListener('focus', (e) => e.target.select());
$('#toggle').onclick = async () => {
  const open = await api.togglePanel();
  document.body.classList.toggle('closed', !open);
};

api.on('tabs:update', async (d) => {
  const changed = d.activeId !== activeId;
  tabs = d.tabs;
  activeId = d.activeId;
  renderTabs();

  const t = tabs.find((x) => x.id === activeId);
  if (t) {
    $('#back').disabled = !t.canGoBack;
    $('#fwd').disabled = !t.canGoForward;
    $('#reload').textContent = t.loading ? '…' : '⟳';
    if (document.activeElement !== $('#url')) $('#url').value = t.url;
  }

  if (changed) {
    net = new Map((await api.netList()).map((e) => [e.id, e]));
    selected = null;
    renderNet();
    $('#detail').innerHTML = '<div class="empty">Select a request to see its headers and body.</div>';
    wasLoading = false;
    if (panelTab === 'src') refreshSource();
  } else if (t) {
    // refresh the source automatically when a page finishes loading
    if (wasLoading && !t.loading && panelTab === 'src') refreshSource();
    wasLoading = t.loading;
  }
});

// ---------- panel switching ----------
$('#ptabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  panelTab = b.dataset.p;
  document.querySelectorAll('#ptabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'p-' + panelTab));
  if (panelTab === 'src') refreshSource();
});

// ---------- source viewer ----------
async function refreshSource() {
  $('#srcView').textContent = 'Loading…';
  srcData = await api.source();
  showSource();
}

function showSource() {
  if (!srcData) { $('#srcView').textContent = 'No page open.'; return; }
  const text = srcMode === 'raw' ? srcData.raw ?? '(Raw HTML unavailable. Use Rendered DOM, or reload the page with the inspector open.)' : srcData.dom;
  $('#srcView').textContent = text || '(empty)';
}

document.querySelectorAll('[data-m]').forEach((b) => {
  b.onclick = () => {
    srcMode = b.dataset.m;
    document.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
    showSource();
  };
});
$('#srcRefresh').onclick = refreshSource;
$('#srcCopy').onclick = () => navigator.clipboard.writeText($('#srcView').textContent);

// ---------- network inspector ----------
let renderQueued = false;
api.on('net:update', (e) => {
  net.set(e.id, e);
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNet(); });
  }
});

const statusClass = (e) => (e.error ? 'sx' : e.status ? 's' + String(e.status)[0] : '');
const fmtSize = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const shortUrl = (u) => { try { const x = new URL(u); return x.host + x.pathname + x.search; } catch { return u; } };

function renderNet() {
  const q = $('#filter').value.trim().toLowerCase();
  const rows = [...net.values()].filter(
    (e) => !q || `${e.method} ${e.type} ${e.url} ${e.status || ''}`.toLowerCase().includes(q)
  );
  if (!rows.length) {
    $('#list').innerHTML = '<div class="empty">No requests yet. Load a page with the Network tab open.</div>';
    return;
  }
  const stick = $('#list').scrollTop + $('#list').clientHeight >= $('#list').scrollHeight - 30;
  $('#list').innerHTML =
    '<table>' +
    rows
      .map(
        (e) => `<tr data-id="${esc(e.id)}" class="${e.id === selected ? 'sel' : ''}" title="${esc(e.url)}">
          <td class="m">${esc(e.method)}</td>
          <td class="s ${statusClass(e)}">${esc(e.error ? 'ERR' : e.status ?? '…')}</td>
          <td class="t">${esc(e.type)}</td>
          <td>${esc(shortUrl(e.url))}</td>
          <td class="z">${fmtSize(e.size)}</td>
        </tr>`
      )
      .join('') +
    '</table>';
  if (stick) $('#list').scrollTop = $('#list').scrollHeight;
}

$('#filter').addEventListener('input', renderNet);
$('#netClear').onclick = async () => {
  await api.netClear();
  net.clear();
  selected = null;
  renderNet();
  $('#detail').innerHTML = '<div class="empty">Select a request to see its headers and body.</div>';
};
$('#har').onclick = () => api.exportHar();

$('#list').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  selected = tr.dataset.id;
  renderNet();
  showDetail(net.get(selected));
});

function headersBlock(h) {
  const entries = Object.entries(h || {});
  if (!entries.length) return '<div class="empty" style="padding:0">none</div>';
  return entries.map(([k, v]) => `<div class="kv"><b>${esc(k)}:</b> ${esc(v)}</div>`).join('');
}

function showDetail(e) {
  if (!e) return;
  $('#detail').innerHTML = `
    <h4>General</h4>
    <div class="kv"><b>URL:</b> ${esc(e.url)}</div>
    <div class="kv"><b>Method:</b> ${esc(e.method)}</div>
    <div class="kv"><b>Status:</b> ${esc(e.error || `${e.status ?? ''} ${e.statusText ?? ''}`)}</div>
    <div class="kv"><b>Type:</b> ${esc(e.type)} ${e.mimeType ? '(' + esc(e.mimeType) + ')' : ''}</div>
    ${e.remoteIP ? `<div class="kv"><b>Remote:</b> ${esc(e.remoteIP)} ${esc(e.protocol || '')}</div>` : ''}
    ${e.duration != null ? `<div class="kv"><b>Time:</b> ${e.duration} ms</div>` : ''}
    <h4>Request headers</h4>${headersBlock(e.requestHeaders)}
    ${e.postData ? `<h4>Request payload</h4><pre>${esc(e.postData)}</pre>` : ''}
    <h4>Response headers</h4>${headersBlock(e.responseHeaders)}
    <h4>Response body</h4>
    <button id="loadBody" style="padding:4px 10px;background:var(--tab)">Load body</button>
    <div id="bodyOut"></div>`;
  $('#loadBody').onclick = async () => {
    const r = await api.netBody(e.id);
    const out = $('#bodyOut');
    if (r.error) out.innerHTML = `<div class="empty" style="padding:6px 0">${esc(r.error)}</div>`;
    else if (r.base64) out.innerHTML = `<div class="empty" style="padding:6px 0">Binary content (${fmtSize(e.size)}).</div>`;
    else out.innerHTML = `<pre>${esc(r.body.slice(0, 200000))}</pre>`;
  };
}

renderNet();