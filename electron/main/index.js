const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path  = require('path')
const https = require('https')
const Store = require('electron-store')
const obd   = require('../lib/obd.js')
const cloud = require('../lib/cloud.js')
const { autoUpdater } = require('electron-updater')

// ── Persistent storage ────────────────────────────────────────────────────────
const store = new Store({ name: 'gearbrain-data', encryptionKey: 'td-2025-secure' })

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const isDev         = process.env.NODE_ENV === 'development' || !app.isPackaged
const VITE_DEV_URL  = 'http://localhost:5173'

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'GearBrain', backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
    autoHideMenuBar: true,
  })
  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}
// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // V dev módu auto-update nespouštíme
  if (isDev) return

  autoUpdater.autoDownload    = false   // Stáhnout až po souhlasu uživatele
  autoUpdater.autoInstallOnAppQuit = true

  // Dostupná aktualizace — pošleme info do UI
  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('updater:available', {
      version:      info.version,
      releaseNotes: info.releaseNotes ?? null,
      releaseDate:  info.releaseDate  ?? null,
    })
  })

  // Žádná aktualizace — tiše ignorujeme
  autoUpdater.on('update-not-available', () => {})

  // Průběh stahování
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('updater:progress', {
      percent: Math.round(progress.percent),
      speed:   Math.round(progress.bytesPerSecond / 1024), // KB/s
    })
  })

  // Staženo — připraveno k instalaci
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('updater:downloaded')
  })

  // Chyba při aktualizaci — tiše logujeme, neblokujeme UI
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message)
    mainWindow?.webContents.send('updater:error', err.message)
  })

  // Zkontrolovat aktualizace 3s po startu (aby se nejdřív načetlo UI)
  setTimeout(() => autoUpdater.checkForUpdates(), 3000)
}

app.whenReady().then(() => {
  createWindow()
  setupAutoUpdater()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── IPC: Storage ──────────────────────────────────────────────────────────────
ipcMain.handle('storage:get',    (_e, k)    => store.get(k, null))
ipcMain.handle('storage:set',    (_e, k, v) => { store.set(k, v); return true })
ipcMain.handle('storage:delete', (_e, k)    => { store.delete(k); return true })

// ── IPC: API klíč ─────────────────────────────────────────────────────────────
ipcMain.handle('apikey:get',    ()      => store.get('anthropic_api_key', null))
ipcMain.handle('apikey:set',    (_e, k) => { store.set('anthropic_api_key', k); return true })
ipcMain.handle('apikey:delete', ()      => { store.delete('anthropic_api_key'); return true })

// ── IPC: AI model ─────────────────────────────────────────────────────────────
ipcMain.handle('model:get', ()      => store.get('anthropic_model', DEFAULT_MODEL))
ipcMain.handle('model:set', (_e, m) => { store.set('anthropic_model', m); return true })

// ── IPC: Anthropic API ────────────────────────────────────────────────────────
ipcMain.handle('claude:call', (_e, { systemPrompt, userMessage, maxTokens = 4000 }) => {
  return new Promise((resolve, reject) => {
    const apiKey = store.get('anthropic_api_key')
    if (!apiKey) { reject(new Error('API klíč není nastaven.')); return }
    const model = store.get('anthropic_model', DEFAULT_MODEL)
    const body  = JSON.stringify({
      model, max_tokens: maxTokens, system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(`Anthropic: ${parsed.error.message}`))
          else resolve(parsed)
        } catch { reject(new Error('Chyba při zpracování odpovědi API.')) }
      })
    })
    req.on('error', e => reject(new Error(`Síťová chyba: ${e.message}`)))
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Vypršel časový limit (60s).')) })
    req.write(body)
    req.end()
  })
})

// ── IPC: Cloud (Supabase) ─────────────────────────────────────────────────────

/** Vrátí konfiguraci Supabase (URL + anon klíč), nebo null pokud není nastavena */
function getCloudConfig() {
  const url = store.get('supabase_url', null)
  const key = store.get('supabase_anon_key', null)
  if (!url || !key) return null
  return { url, key }
}

/** Vrátí nebo vygeneruje installation_id (anonymní UUID této instalace) */
function getInstallationId() {
  let id = store.get('installation_id', null)
  if (!id) {
    // Jednoduchá UUID v4 generace bez závislostí
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
    store.set('installation_id', id)
  }
  return id
}

/** Nastaví Supabase konfiguraci */
ipcMain.handle('cloud:config-set', (_e, { url, anonKey }) => {
  store.set('supabase_url', url.trim().replace(/\/$/, ''))
  store.set('supabase_anon_key', anonKey.trim())
  return { ok: true }
})

/** Vrátí aktuální konfiguraci (maskovaný klíč pro zobrazení) */
ipcMain.handle('cloud:config-get', () => {
  const url = store.get('supabase_url', '')
  const key = store.get('supabase_anon_key', '')
  return {
    url,
    keyMasked: key ? `${key.slice(0, 20)}••••••••${key.slice(-6)}` : '',
    enabled:   !!(url && key),
    installationId: getInstallationId(),
  }
})

/** Smaže konfiguraci */
ipcMain.handle('cloud:config-delete', () => {
  store.delete('supabase_url')
  store.delete('supabase_anon_key')
  return { ok: true }
})

/** Testuje spojení se Supabase */
ipcMain.handle('cloud:test', async () => {
  const cfg = getCloudConfig()
  if (!cfg) return { ok: false, error: 'Supabase není nakonfigurovaný' }
  return cloud.testConnection(cfg.url, cfg.key)
})

/**
 * Odešle uzavřený případ do globální databáze.
 * Spravuje violation tracking — po 3 porušeních instalaci zablokuje.
 * Volá se fire-and-forget z App.jsx.
 */
ipcMain.handle('cloud:push', async (_e, kase) => {
  const cfg = getCloudConfig()
  if (!cfg) return { ok: false, error: 'cloud není nakonfigurovaný' }

  const installationId   = getInstallationId()
  const violationState   = store.get('violation_state', { count: 0, blocked: false })

  const result = await cloud.pushCase(cfg.url, cfg.key, installationId, kase, violationState)

  // Zaznamenat porušení validace (ne síťové chyby)
  if (!result.ok && result.violation) {
    const newCount = violationState.count + 1
    const blocked  = newCount >= 3
    const newState = { count: newCount, blocked, lastViolation: result.violation, updatedAt: new Date().toISOString() }
    store.set('violation_state', newState)

    // Reportovat do Supabase (trigger pošle email)
    cloud.reportViolation(cfg.url, cfg.key, installationId, result.violation, newCount)
      .catch(() => {})
  }

  return result
})


/** Zavolá Edge Function search-cases pro RAG (per-query, žádná lokální cache) */
ipcMain.handle('cloud:search-cases', async (_e, { input, installationId }) => {
  const cfg = getCloudConfig()
  if (!cfg) return { cases: [], error: null }
  return cloud.searchCases(cfg.url, cfg.key, input, installationId)
})

// ── IPC: OBD / ELM327 ────────────────────────────────────────────────────────
let activePort   = null
let activeParser = null

function getSerialPort() {
  try { return require('serialport') } catch { return null }
}

function sendCommand(cmd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!activePort?.isOpen || !activeParser) {
      reject(new Error('Port není otevřen'))
      return
    }
    let buffer     = ''
    let chunkTimer = null
    const globalTimer = setTimeout(() => {
      activeParser.removeListener('data', onData)
      clearTimeout(chunkTimer)
      resolve(buffer || '')
    }, timeoutMs)

    const onData = (chunk) => {
      buffer += chunk.toString()
      clearTimeout(chunkTimer)
      chunkTimer = setTimeout(() => {
        activeParser.removeListener('data', onData)
        clearTimeout(globalTimer)
        resolve(buffer)
      }, 150)
    }

    activeParser.on('data', onData)
    activePort.write(cmd + '\r', (err) => {
      if (err) {
        activeParser.removeListener('data', onData)
        clearTimeout(globalTimer)
        clearTimeout(chunkTimer)
        reject(new Error(`Chyba zápisu: ${err.message}`))
      }
    })
  })
}

ipcMain.handle('obd:list-ports', async () => {
  const sp = getSerialPort()
  if (!sp) return { ports: [], error: 'Modul serialport není nainstalován — spusťte npm install' }
  try {
    const list = await sp.SerialPort.list()
    return {
      ports: list.map(p => ({
        path:         p.path,
        friendlyName: p.friendlyName || p.path,
        manufacturer: p.manufacturer || '',
        likelyObd:    ['ch340','ftdi','elm','obd','prolific','silicon labs']
                        .some(kw => (p.manufacturer || p.friendlyName || '').toLowerCase().includes(kw)),
      })),
      error: null,
    }
  } catch (e) { return { ports: [], error: e.message } }
})

ipcMain.handle('obd:connect', async (_e, { portPath, baudRate = 38400 }) => {
  const sp = getSerialPort()
  if (!sp) return { ok: false, error: 'Modul serialport není nainstalován' }
  if (activePort?.isOpen) await new Promise(r => activePort.close(r))
  activePort = null; activeParser = null

  return new Promise((resolve) => {
    const port = new sp.SerialPort({ path: portPath, baudRate, autoOpen: false })
    port.open(async (err) => {
      if (err) { resolve({ ok: false, error: `Nelze otevřít port: ${err.message}` }); return }
      const parser = port.pipe(new sp.parsers.Readline({ delimiter: '>', encoding: 'ascii' }))
      activePort = port; activeParser = parser
      try {
        for (const step of obd.INIT_COMMANDS) {
          await new Promise(r => setTimeout(r, step.delay))
          await sendCommand(step.cmd, step.delay + 1000)
        }
        resolve({ ok: true, error: null })
      } catch (e) {
        port.close(); activePort = null; activeParser = null
        resolve({ ok: false, error: `Chyba inicializace: ${e.message}` })
      }
    })
    port.on('error', (e) => { if (!activePort) resolve({ ok: false, error: e.message }) })
  })
})

ipcMain.handle('obd:read-codes', async (_e, { includePending = true } = {}) => {
  if (!activePort?.isOpen) return { stored: [], pending: [], error: 'Adaptér není připojen' }
  try {
    const rawStored = await sendCommand(obd.CMD_READ_STORED, obd.READ_TIMEOUT_MS)
    const { codes: stored, error: storedErr } = obd.parseDtcResponse(rawStored, '03')
    if (storedErr) return { stored: [], pending: [], error: storedErr }
    let pending = []
    if (includePending) {
      try {
        const rawPending = await sendCommand(obd.CMD_READ_PENDING, 6000)
        const { codes } = obd.parseDtcResponse(rawPending, '07')
        pending = codes.filter(c => !stored.includes(c))
      } catch { /* pending nejsou kritické */ }
    }
    return { stored, pending, error: null }
  } catch (e) { return { stored: [], pending: [], error: e.message } }
})

ipcMain.handle('obd:disconnect', async () => {
  if (activePort?.isOpen) await new Promise(r => activePort.close(r))
  activePort = null; activeParser = null
  return { ok: true }
})
