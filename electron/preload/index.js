const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Anthropic API
  callClaude: (params) => ipcRenderer.invoke('claude:call', params),

  // Persistent storage
  storage: {
    get:    (key)        => ipcRenderer.invoke('storage:get', key),
    set:    (key, value) => ipcRenderer.invoke('storage:set', key, value),
    delete: (key)        => ipcRenderer.invoke('storage:delete', key),
  },

  // API klíč
  apiKey: {
    get:    ()    => ipcRenderer.invoke('apikey:get'),
    set:    (key) => ipcRenderer.invoke('apikey:set', key),
    delete: ()    => ipcRenderer.invoke('apikey:delete'),
  },

  // AI model
  model: {
    get: ()      => ipcRenderer.invoke('model:get'),
    set: (model) => ipcRenderer.invoke('model:set', model),
  },

  // Cloud databáze (Supabase)
  updater: {
    onAvailable:  (cb) => ipcRenderer.on('updater:available',  (_e, info)     => cb(info)),
    onProgress:   (cb) => ipcRenderer.on('updater:progress',   (_e, progress) => cb(progress)),
    onDownloaded: (cb) => ipcRenderer.on('updater:downloaded', ()             => cb()),
    download: () => ipcRenderer.invoke('updater:download'),
    install:  () => ipcRenderer.invoke('updater:install'),
    check:    () => ipcRenderer.invoke('updater:check'),
  },
  cloud: {
    configGet:    ()              => ipcRenderer.invoke('cloud:config-get'),
    configSet:    (url, anonKey)  => ipcRenderer.invoke('cloud:config-set', { url, anonKey }),
    configDelete: ()              => ipcRenderer.invoke('cloud:config-delete'),
    test:         ()              => ipcRenderer.invoke('cloud:test'),
    push:         (kase)          => ipcRenderer.invoke('cloud:push', kase),
    fetchAll:     (opts)          => ipcRenderer.invoke('cloud:fetch-all', opts),
  },

  // OBD-II / ELM327
  obd: {
    listPorts:  ()                   => ipcRenderer.invoke('obd:list-ports'),
    connect:    (portPath, baudRate) => ipcRenderer.invoke('obd:connect', { portPath, baudRate }),
    readCodes:  (opts)               => ipcRenderer.invoke('obd:read-codes', opts),
    disconnect: ()                   => ipcRenderer.invoke('obd:disconnect'),
  },
})
