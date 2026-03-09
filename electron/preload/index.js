const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Anthropic API
  callClaude: (params) => ipcRenderer.invoke('claude:call', params),
  abortClaude: ()      => ipcRenderer.invoke('claude:abort'),

  // Validace (sdílená mezi UI a cloud pushem)
  validateResolution: (text) => ipcRenderer.invoke('validate:resolution', text),

  // Persistent storage
  storage: {
    get:    (key)        => ipcRenderer.invoke('storage:get', key),
    set:    (key, value) => ipcRenderer.invoke('storage:set', key, value),
    delete: (key)        => ipcRenderer.invoke('storage:delete', key),
  },

  // AI model
  model: {
    get: ()      => ipcRenderer.invoke('model:get'),
    set: (model) => ipcRenderer.invoke('model:set', model),
  },

  // Auto-updater (listenery s cleanup funkcí — zabraňuje memory leaku)
  updater: {
    onAvailable: (cb) => {
      const handler = (_e, info) => cb(info)
      ipcRenderer.on('updater:available', handler)
      return () => ipcRenderer.removeListener('updater:available', handler)
    },
    onProgress: (cb) => {
      const handler = (_e, progress) => cb(progress)
      ipcRenderer.on('updater:progress', handler)
      return () => ipcRenderer.removeListener('updater:progress', handler)
    },
    onDownloaded: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('updater:downloaded', handler)
      return () => ipcRenderer.removeListener('updater:downloaded', handler)
    },
    onError: (cb) => {
      const handler = (_e, msg) => cb(msg)
      ipcRenderer.on('updater:error', handler)
      return () => ipcRenderer.removeListener('updater:error', handler)
    },
    download: () => ipcRenderer.invoke('updater:download'),
    install:  () => ipcRenderer.invoke('updater:install'),
    check:    () => ipcRenderer.invoke('updater:check'),
  },
  // Cloud databáze (Supabase)
  cloud: {
    configGet:    ()              => ipcRenderer.invoke('cloud:config-get'),
    push:         (kase)          => ipcRenderer.invoke('cloud:push', kase),
    searchCases:  (input, installationId) => ipcRenderer.invoke('cloud:search-cases', { input, installationId }),
  },

  // OBD-II / ELM327
  obd: {
    listPorts:  ()                   => ipcRenderer.invoke('obd:list-ports'),
    connect:    (portPath, baudRate) => ipcRenderer.invoke('obd:connect', { portPath, baudRate }),
    readCodes:  (opts)               => ipcRenderer.invoke('obd:read-codes', opts),
    disconnect: ()                   => ipcRenderer.invoke('obd:disconnect'),
  },
})
