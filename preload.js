const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(['tabs:update', 'net:update']);

contextBridge.exposeInMainWorld('api', {
  newTab: (url) => call('tab:new', url),
  closeTab: (id) => call('tab:close', id),
  activateTab: (id) => call('tab:activate', id),

  go: (input) => call('nav:go', input),
  back: () => call('nav:back'),
  forward: () => call('nav:forward'),
  reload: () => call('nav:reload'),

  togglePanel: () => call('panel:toggle'),

  netList: () => call('net:list'),
  netClear: () => call('net:clear'),
  netBody: (id) => call('net:body', id),
  exportHar: () => call('net:har'),
  source: () => call('src:get'),

  on: (channel, fn) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});