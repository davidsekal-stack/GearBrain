const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const https = require('https')
const Store = require('electron-store')

// ── Persistent storage ────────────────────────────────────────────────────────
const store = new Store({
  name: 'gearbrain-data',
  encryptionKey: 'td-2025-secure', // obfuskace (ne šifrování production-grade)
})

// ── Dev vs prod URL ───────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const VITE_DEV_URL = 'http://localhost:5173'

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'GearBrain',
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    // Skryj menu bar (lze obnovit Alt)
    autoHideMenuBar: true,
  })

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  // Otevři externí linky v systémovém prohlížeči
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC: Storage ──────────────────────────────────────────────────────────────
ipcMain.handle('storage:get', (_event, key) => {
  return store.get(key, null)
})

ipcMain.handle('storage:set', (_event, key, value) => {
  store.set(key, value)
  return true
})

ipcMain.handle('storage:delete', (_event, key) => {
  store.delete(key)
  return true
})

// ── IPC: API klíč ─────────────────────────────────────────────────────────────
ipcMain.handle('apikey:get', () => {
  return store.get('anthropic_api_key', null)
})

ipcMain.handle('apikey:set', (_event, key) => {
  store.set('anthropic_api_key', key)
  return true
})

ipcMain.handle('apikey:delete', () => {
  store.delete('anthropic_api_key')
  return true
})

// ── IPC: Volání Anthropic API (přes main process – klíč nikdy neopustí backend) ──
ipcMain.handle('claude:call', (_event, { systemPrompt, userMessage, maxTokens = 4000 }) => {
  return new Promise((resolve, reject) => {
    const apiKey = store.get('anthropic_api_key')
    if (!apiKey) {
      reject(new Error('API klíč není nastaven. Přejděte do Nastavení.'))
      return
    }

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) {
            reject(new Error(`Anthropic API chyba: ${parsed.error.message}`))
          } else {
            resolve(parsed)
          }
        } catch (e) {
          reject(new Error('Chyba při zpracování odpovědi API.'))
        }
      })
    })

    req.on('error', (e) => {
      reject(new Error(`Síťová chyba: ${e.message}`))
    })

    req.setTimeout(60000, () => {
      req.destroy()
      reject(new Error('Vypršel časový limit požadavku (60s).'))
    })

    req.write(body)
    req.end()
  })
})
