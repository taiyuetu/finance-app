'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:get'),
  saveData: (data) => ipcRenderer.invoke('data:set', data),
  dataPath: () => ipcRenderer.invoke('data:path'),
  exportCsv: (csv, suggestedName) => ipcRenderer.invoke('data:export', csv, suggestedName),
  pickStatement: () => ipcRenderer.invoke('import:pick'),
  onDataChanged: (cb) => ipcRenderer.on('data:external-changed', () => cb())
});
