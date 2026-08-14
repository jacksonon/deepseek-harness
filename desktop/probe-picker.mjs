// TEMP diagnostic probe — delete after the picker investigation closes.
// Spawns the PACKAGED win32 dialog worker exactly as dsh-host-directory-picker-native
// does, under either plain node (CI baseline) or the packaged-app Electron binary
// in ELECTRON_RUN_AS_NODE mode (the desktop app's real spawn path), and prints the
// worker's protocol messages, stderr, and exit code.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const appRoot = process.argv[2]
const mode = process.argv[3] ?? 'node'
const worker = path.join(
  appRoot, 'resources', 'app', 'node_modules', '@deepseek-ai',
  'dsh-host-directory-picker-native', 'lib', 'worker.cjs',
)
const electron = process.env.PROBE_ELECTRON ?? ''
const exe = mode === 'electron' ? electron : process.execPath

console.log(`[probe] mode=${mode}`)
console.log(`[probe] exe=${exe}`)
console.log(`[probe] worker=${worker} exists=${existsSync(worker)}`)
if (mode === 'electron' && !existsSync(electron)) {
  console.log('[probe] ELECTRON_MISSING')
  process.exit(1)
}
if (!existsSync(worker)) {
  console.log('[probe] WORKER_MISSING')
  process.exit(1)
}

const child = spawn(exe, [worker], {
  env: { ...process.env, DSH_DIALOG_TITLE: 'Probe folder dialog' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
})
let stderr = ''
child.stderr.on('data', (d) => {
  stderr += d
  process.stdout.write(`[worker-stderr] ${d}`)
})
const timer = setTimeout(() => {
  console.log('[probe] TIMEOUT (dialog still open); killing worker')
  child.kill()
}, 8000)
child.on('message', (m) => {
  // 'showing' proves IPC + koffi + COM all work; the dialog then blocks
  // until the timer above kills the worker.
  console.log(`[probe] WORKER_MESSAGE ${JSON.stringify(m)}`)
})
child.on('error', (e) => {
  clearTimeout(timer)
  console.log(`[probe] SPAWN_ERROR ${e.message}`)
})
child.on('exit', (code, signal) => {
  clearTimeout(timer)
  console.log(`[probe] WORKER_EXIT code=${code} signal=${signal}`)
  console.log(`[probe] STDERR_TAIL ${JSON.stringify(stderr.slice(-600))}`)
  process.exit(0)
})
