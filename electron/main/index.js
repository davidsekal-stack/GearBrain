const { app, BrowserWindow, ipcMain, shell, session } = require('electron')
const path   = require('path')
const https  = require('https')
const crypto = require('crypto')
const Store  = require('electron-store')
const obd    = require('../lib/obd.js')
const cloud  = require('../lib/cloud.js')
const { validateResolution } = require('../lib/validation.js')
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
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
    autoHideMenuBar: true,
  })

  // ── CSP ──────────────────────────────────────────────────────────────────────
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          " script-src 'self';" +
          " style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
          " font-src 'self' https://fonts.gstatic.com;" +
          " connect-src 'self';" +
          " img-src 'self' data:;"
        ],
      },
    })
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

// ── IPC: Auto-updater ─────────────────────────────────────────────────────────
ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate())
ipcMain.handle('updater:install',  () => autoUpdater.quitAndInstall())
ipcMain.handle('updater:check',    () => autoUpdater.checkForUpdates())

app.whenReady().then(() => {
  createWindow()
  setupAutoUpdater()
  retryPendingPushes()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── IPC: Validace ─────────────────────────────────────────────────────────────
ipcMain.handle('validate:resolution', (_e, text) => validateResolution(text))

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
let activeClaudeReq = null

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
      const chunks = []
      res.on('data', c => { chunks.push(c) })
      res.on('end', () => {
        activeClaudeReq = null
        try {
          const data   = Buffer.concat(chunks).toString('utf8')
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(`Anthropic: ${parsed.error.message}`))
          else resolve(parsed)
        } catch { reject(new Error('Chyba při zpracování odpovědi API.')) }
      })
    })
    activeClaudeReq = req
    req.on('error', e => { activeClaudeReq = null; reject(new Error(`Síťová chyba: ${e.message}`)) })
    req.setTimeout(120000, () => { req.destroy(); activeClaudeReq = null; reject(new Error('Vypršel časový limit (120s). Zkontrolujte připojení k internetu.')) })
    req.write(body)
    req.end()
  })
})

ipcMain.handle('claude:abort', () => {
  if (activeClaudeReq) {
    activeClaudeReq.destroy()
    activeClaudeReq = null
    return { ok: true }
  }
  return { ok: false }
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
    id = crypto.randomUUID()
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

// ── Cloud push s retry frontou ────────────────────────────────────────────────
const PUSH_QUEUE_KEY = 'gearbrain_push_queue'

/**
 * Odešle uzavřený případ do globální databáze.
 * Při selhání uloží případ do retry fronty.
 */
ipcMain.handle('cloud:push', async (_e, kase) => {
  const cfg = getCloudConfig()
  if (!cfg) return { ok: false, error: 'cloud není nakonfigurovaný' }
  const result = await cloud.pushCase(cfg.url, cfg.key, getInstallationId(), kase)
  if (!result.ok && result.error !== 'validation') {
    addToPushQueue(kase)
  }
  return result
})

function addToPushQueue(kase) {
  const queue = store.get(PUSH_QUEUE_KEY, [])
  if (queue.some(q => q.id === kase.id)) return
  queue.push(kase)
  store.set(PUSH_QUEUE_KEY, queue)
}

async function retryPendingPushes() {
  const cfg = getCloudConfig()
  if (!cfg) return
  const queue = store.get(PUSH_QUEUE_KEY, [])
  if (queue.length === 0) return

  const remaining = []
  for (const kase of queue) {
    const result = await cloud.pushCase(cfg.url, cfg.key, getInstallationId(), kase)
    if (!result.ok) remaining.push(kase)
  }
  store.set(PUSH_QUEUE_KEY, remaining)
  if (remaining.length < queue.length) {
    console.log(`[cloud retry] ${queue.length - remaining.length}/${queue.length} případů úspěšně odesláno`)
  }
}


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
