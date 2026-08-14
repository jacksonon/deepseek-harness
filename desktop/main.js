'use strict'

/**
 * DeepSeek Harness desktop shell (Electron main process).
 *
 * Fully standalone: the harness GUI cannot run alone — only the `dsh web`
 * server injects `window.__DSH_BOOT__` and serves the /api transport — so the
 * server runtime is BUNDLED with this app (@deepseek-ai/dsh is a real
 * dependency) and booted as a child process under Electron's own Node
 * (ELECTRON_RUN_AS_NODE). No external `dsh` CLI, no external Node, no PATH
 * configuration is needed on the target machine.
 *
 * The child runs `dsh web --port 0` (OS-assigned free port, so it never
 * collides with an already-running `dsh web`); the shell waits for the
 * readiness line (`dsh web: http://127.0.0.1:<port>`) and loads that URL in
 * a locked-down BrowserWindow. Closing the window terminates the server with
 * it. API keys and other configuration are entered in the GUI (settings) or
 * through the usual dsh environment/DSH_HOME channels.
 *
 * Overrides (development/testing):
 *   DSH_DESKTOP_DASH       — spawn this executable instead of the bundled
 *                            server (e.g. a repository checkout's CLI).
 *   DSH_DESKTOP_EXTRA_ARGS — space-separated extra flags passed to
 *                            `dsh web` (e.g. `--trusted-host app.internal:3080`).
 *
 * `DSH_DESKTOP_SMOKE=1` runs a self-check: boot the server, load the GUI,
 * print `DSH_DESKTOP_SMOKE_OK <url>`, and exit 0; any failure exits 1 with
 * the reason on stderr.
 */

const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')

const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'
/** The web-app readiness line: `dsh web: http://127.0.0.1:<port>` (LAN suffix ignored). */
const READY_LINE = /dsh web: (https?:\/\/\S+)/
const SERVER_BOOT_TIMEOUT_MS = 60_000
const SERVER_EXIT_GRACE_MS = 2_000
const SMOKE_SETTLE_MS = 1_500
const WINDOW = { width: 1280, height: 840, minWidth: 960, minHeight: 640 }

let child = null
let serverUrl = null
let win = null
let quitting = false
let bootTimer = null
const stderrTail = []

/** Fail loudly (dialog in interactive mode, stderr in smoke mode) and exit 1. */
function fatal(message) {
  // app.exit() skips the before-quit lifecycle, so the server child must be
  // stopped here or it would survive as an orphaned process.
  quitting = true
  stopServer()
  if (SMOKE) {
    console.error(`DSH_DESKTOP_SMOKE_FAIL: ${message}`)
    app.exit(1)
  } else {
    dialog.showErrorBox('DeepSeek Harness', message)
    app.exit(1)
  }
}

/** The bundled CLI entry (`lib/bin.js` of the @deepseek-ai/dsh dependency). */
function resolveBundledCli() {
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch (err) {
    fatal(`The bundled harness server is missing (@deepseek-ai/dsh). Reinstall the app, or run \`npm install\` in the desktop directory.\n\n${err.message}`)
    return null
  }
}

/** `web --port 0` plus the user's extra flags. */
function serverArgs() {
  const extras = (process.env.DSH_DESKTOP_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)
  return ['web', '--port', '0', ...extras]
}

/** Split a stream into lines without blocking on partial chunks. */
function attachLineReader(stream, onLine) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    let nl
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, '')
      pending = pending.slice(nl + 1)
      onLine(line)
    }
  })
  stream.on('end', () => {
    if (pending !== '') onLine(pending)
  })
}

/** SIGTERM, then SIGKILL after a short grace period. */
function stopServer() {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, SERVER_EXIT_GRACE_MS)
  timer.unref()
}

function quitApp() {
  if (quitting) return
  quitting = true
  stopServer()
  app.quit()
}

function createWindow() {
  win = new BrowserWindow({
    ...WINDOW,
    title: 'DeepSeek Harness',
    backgroundColor: '#0b0f18',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
    quitApp()
  })

  // External links open in the system browser; nothing opens in-app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The GUI must never leave its own server origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== serverUrl && !url.startsWith(`${serverUrl}/`)) event.preventDefault()
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    fatal(`The harness GUI failed to load (${validatedURL}): ${errorDescription} (${errorCode})`)
  })
  win.webContents.on('did-finish-load', () => {
    if (!SMOKE) return
    setTimeout(() => {
      console.log(`DSH_DESKTOP_SMOKE_OK ${serverUrl}`)
      // Same orphan-prevention as fatal(): stop the server before app.exit().
      quitting = true
      stopServer()
      app.exit(0)
    }, SMOKE_SETTLE_MS)
  })

  void win.loadURL(serverUrl)
}

function startServer() {
  const override = process.env.DSH_DESKTOP_DASH
  const args = serverArgs()

  let executable
  let argv
  let env
  if (override !== undefined && override !== '') {
    // Dev/testing override: run an external `dsh` (e.g. a repo checkout).
    executable = override
    argv = args
    env = process.env
    console.log(`[desktop] spawning server (DSH_DESKTOP_DASH): ${executable} ${argv.join(' ')}`)
  } else {
    // Standalone: the bundled CLI under Electron's own Node.
    const cli = resolveBundledCli()
    if (cli === null) return
    executable = process.execPath
    // The harness HMR plugin probes Node internals; plain node boots pass
    // this flag through the launcher. Electron forbids it in NODE_OPTIONS,
    // but ELECTRON_RUN_AS_NODE mode honors command-line node flags before
    // the script path.
    argv = ['--expose-internals', cli, ...args]
    env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    console.log(`[desktop] spawning bundled server: ${executable} ${argv.join(' ')}`)
  }

  child = spawn(executable, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })

  attachLineReader(child.stdout, (line) => {
    console.log(`[dsh] ${line}`)
    const match = READY_LINE.exec(line)
    if (match !== null && serverUrl === null) {
      serverUrl = match[1]
      clearTimeout(bootTimer)
      console.log(`[desktop] server ready: ${serverUrl}`)
      createWindow()
    }
  })
  attachLineReader(child.stderr, (line) => {
    console.error(`[dsh] ${line}`)
    stderrTail.push(line)
    if (stderrTail.length > 30) stderrTail.shift()
  })

  child.on('error', (err) => {
    fatal(`Failed to start the harness server (${executable}): ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    if (quitting) return
    if (serverUrl === null) {
      const tail = stderrTail.length > 0 ? `\n\nServer output:\n${stderrTail.join('\n')}` : ''
      fatal(`The harness server exited before becoming ready (code ${code ?? 'null'}, signal ${signal ?? 'none'}).${tail}`)
    } else {
      fatal(`The harness server stopped unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'}). The app will close.`)
    }
  })

  bootTimer = setTimeout(() => {
    stopServer()
    fatal(
      `The harness server did not print its readiness line within ${SERVER_BOOT_TIMEOUT_MS / 1000}s.\n\n`
      + `Server output:\n${stderrTail.join('\n')}`,
    )
  }, SERVER_BOOT_TIMEOUT_MS)
}

// Smoke runs are self-contained probes: they must be able to run while a
// real instance is open (CI, parallel testing), so they skip the lock.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    app.setName('DeepSeek Harness')
    startServer()
  })

  app.on('window-all-closed', quitApp)
  app.on('before-quit', () => {
    quitting = true
    stopServer()
  })
  process.on('SIGINT', quitApp)
  process.on('SIGTERM', quitApp)
}
