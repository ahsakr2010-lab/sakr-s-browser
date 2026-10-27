const { app, BrowserWindow, WebContentsView, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const TOP = 84;        // tab strip (36) + toolbar (48), must match index.html
const PANEL_W = 460;   // side panel width, must match index.html
const HOME = 'https://www.google.com';
const MAX_LOG = 3000;

let win;
let panelOpen = true;
let activeId = null;
let nextId = 1;
const tabs = new Map();

// ---------- helpers ----------
function normalize(input) {
  const s = (input || '').trim();
  if (!s) return HOME;
  if (/^(https?|file|about|chrome|view-source):/i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

const toPairs = (h) =>
  Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));

function layout() {
  if (!win || win.isDestroyed()) return;
  const t = tabs.get(activeId);
  if (!t) return;
  const [w, h] = win.getContentSize();
  t.view.setBounds({
    x: 0,
    y: TOP,
    width: Math.max(0, w - (panelOpen ? PANEL_W : 0)),
    height: Math.max(0, h - TOP),
  });
}

function sendTabs() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('tabs:update', {
    activeId,
    tabs: [...tabs.values()].map((t) => {
      const wc = t.view.webContents;
      return {
        id: t.id,
        title: t.title,
        url: wc.getURL(),
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        favicon: t.favicon || null,
      };
    }),
  });
}

// ---------- network capture via Chrome DevTools Protocol ----------
function emit(tab, entry) {
  if (tab.id === activeId && win && !win.isDestroyed()) {
    win.webContents.send('net:update', entry);
  }
}

function attachDebugger(tab) {
  const dbg = tab.view.webContents.debugger;
  dbg.attach('1.3');
  dbg.sendCommand('Network.enable').catch(() => {});

  dbg.on('message', (_e, method, p) => {
    let e = tab.net.get(p.requestId);

    switch (method) {
      case 'Network.requestWillBeSent': {
        if (p.redirectResponse && e) {
          const hop = {
            ...e,
            id: p.requestId + '~' + tab.net.size,
            status: p.redirectResponse.status,
            responseHeaders: p.redirectResponse.headers,
            done: true,
          };
          tab.net.set(hop.id, hop);
          emit(tab, hop);
        }
        e = {
          id: p.requestId,
          url: p.request.url,
          method: p.request.method,
          type: p.type || 'Other',
          requestHeaders: p.request.headers,
          postData: p.request.postData,
          time: Date.now(),
          status: null,
        };
        tab.net.set(p.requestId, e);
        break;
      }
      case 'Network.responseReceived':
        if (!e) return;
        Object.assign(e, {
          status: p.response.status,
          statusText: p.response.statusText,
          mimeType: p.response.mimeType,
          responseHeaders: p.response.headers,
          remoteIP: p.response.remoteIPAddress,
          protocol: p.response.protocol,
        });
        break;
      case 'Network.loadingFinished':
        if (!e) return;
        e.size = p.encodedDataLength;
        e.done = true;
        e.duration = Date.now() - e.time;
        break;
      case 'Network.loadingFailed':
        if (!e) return;
        e.error = p.errorText;
        e.done = true;
        e.duration = Date.now() - e.time;
        break;
      default:
        return;
    }

    if (tab.net.size > MAX_LOG) tab.net.delete(tab.net.keys().next().value);
    emit(tab, e);
  });
}

async function getBody(tab, requestId) {
  try {
    const r = await tab.view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
    return { body: r.body, base64: r.base64Encoded };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------- tabs ----------
function activate(id) {
  const prev = tabs.get(activeId);
  if (prev) win.contentView.removeChildView(prev.view);
  activeId = id;
  const t = tabs.get(id);
  if (t) win.contentView.addChildView(t.view);
  layout();
  sendTabs();
}

function createTab(url = HOME) {
  const id = nextId++;
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  const tab = { id, view, net: new Map(), title: 'New tab', favicon: null };
  tabs.set(id, tab);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    createTab(url);
    return { action: 'deny' };
  });
  wc.on('page-title-updated', (_e, title) => { tab.title = title; sendTabs(); });
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] || null; sendTabs(); });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) {
    wc.on(ev, sendTabs);
  }

  attachDebugger(tab);
  activate(id);
  wc.loadURL(normalize(url));
  return id;
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (id === activeId) win.contentView.removeChildView(t.view);
  tabs.delete(id);
  t.view.webContents.close();

  if (id === activeId) {
    const rest = [...tabs.keys()];
    if (rest.length) activate(rest[rest.length - 1]);
    else createTab(HOME);
  } else {
    sendTabs();
  }
}

const active = () => tabs.get(activeId);

// ---------- IPC ----------
ipcMain.handle('tab:new', (_e, url) => createTab(url));
ipcMain.handle('tab:close', (_e, id) => closeTab(id));
ipcMain.handle('tab:activate', (_e, id) => activate(id));

ipcMain.handle('nav:go', (_e, input) => active()?.view.webContents.loadURL(normalize(input)));
ipcMain.handle('nav:back', () => active()?.view.webContents.navigationHistory.goBack());
ipcMain.handle('nav:forward', () => active()?.view.webContents.navigationHistory.goForward());
ipcMain.handle('nav:reload', () => active()?.view.webContents.reload());

ipcMain.handle('panel:toggle', () => {
  panelOpen = !panelOpen;
  layout();
  return panelOpen;
});

ipcMain.handle('net:list', () => (active() ? [...active().net.values()] : []));
ipcMain.handle('net:clear', () => active()?.net.clear());
ipcMain.handle('net:body', (_e, requestId) => (active() ? getBody(active(), requestId) : { error: 'No tab' }));

ipcMain.handle('src:get', async () => {
  const t = active();
  if (!t) return null;
  const wc = t.view.webContents;
  const url = wc.getURL();

  // Rendered DOM (after JavaScript ran)
  let dom = '';
  try {
    dom = await wc.executeJavaScript('document.documentElement.outerHTML');
  } catch (_) {}

  // Raw HTML exactly as the server sent it (what Chrome's View Source shows)
  let raw = null;
  const doc = [...t.net.values()].reverse().find((e) => e.type === 'Document' && e.url === url && e.status);
  if (doc) {
    const r = await getBody(t, doc.id);
    if (r.body && !r.base64) raw = r.body;
  }
  return { url, raw, dom };
});

ipcMain.handle('net:har', async () => {
  const t = active();
  if (!t) return;
  const entries = [...t.net.values()].map((e) => ({
    startedDateTime: new Date(e.time).toISOString(),
    time: e.duration || 0,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: toPairs(e.requestHeaders),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: -1,
      ...(e.postData ? { postData: { mimeType: '', text: e.postData } } : {}),
    },
    response: {
      status: e.status || 0,
      statusText: e.statusText || '',
      httpVersion: e.protocol || 'HTTP/1.1',
      headers: toPairs(e.responseHeaders),
      cookies: [],
      content: { size: e.size || 0, mimeType: e.mimeType || '' },
      redirectURL: '',
      headersSize: -1,
      bodySize: e.size || -1,
    },
    cache: {},
    timings: { send: 0, wait: e.duration || 0, receive: 0 },
  }));
  const { filePath } = await dialog.showSaveDialog(win, { defaultPath: 'capture.har' });
  if (filePath) {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ log: { version: '1.2', creator: { name: 'mini-browser', version: '1.0' }, entries } }, null, 2)
    );
  }
});

// ---------- app ----------
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    backgroundColor: '#15171c',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  win.on('resize', layout);
  win.webContents.once('did-finish-load', () => createTab(HOME));
});

app.on('window-all-closed', () => app.quit());