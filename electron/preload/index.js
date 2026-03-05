const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Anthropic API (voláno přes main process – klíč zůstává v backendu)
  callClaude: (params) => ipcRenderer.invoke('claude:call', params),

  // Persistent storage
  storage: {
    get: (key) => ipcRenderer.invoke('storage:get', key),
    set: (key, value) => ipcRenderer.invoke('storage:set', key, value),
    delete: (key) => ipcRenderer.invoke('storage:delete', key),
  },

  // API klíč management
  apiKey: {
    get: () => ipcRenderer.invoke('apikey:get'),
    set: (key) => ipcRenderer.invoke('apikey:set', key),
    delete: () => ipcRenderer.invoke('apikey:delete'),
  },
})
