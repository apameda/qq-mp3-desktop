const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qqmp3', Object.freeze({
  getSettings: () => ipcRenderer.invoke('qq:get-settings'),
  chooseFiles: () => ipcRenderer.invoke('qq:choose-files'),
  chooseFolder: () => ipcRenderer.invoke('qq:choose-folder'),
  addPaths: (paths) => ipcRenderer.invoke('qq:add-paths', paths),
  chooseOutput: () => ipcRenderer.invoke('qq:choose-output'),
  start: (settings) => ipcRenderer.invoke('qq:start', settings),
  cancel: () => ipcRenderer.invoke('qq:cancel'),
  clearCompleted: () => ipcRenderer.invoke('qq:clear-completed'),
  removeItem: (id) => ipcRenderer.invoke('qq:remove-item', id),
  clearQueue: () => ipcRenderer.invoke('qq:clear-queue'),
  setKey: (id, key) => ipcRenderer.invoke('qq:set-key', id, key),
  openOutput: (path) => ipcRenderer.invoke('qq:open-output', path),
  getDropPaths: (files) => Array.from(files || []).map((file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  }).filter(Boolean),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('qq:event', handler);
    return () => ipcRenderer.removeListener('qq:event', handler);
  },
}));
