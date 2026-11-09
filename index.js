import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-local-monitor'

/**
 * The dashboard reads live sensor data out of GPU-Z (shared memory) plus the
 * Windows CPU/memory counters, so it needs the Host web server to hand that
 * data to the browser half over one read-only JSON route.
 */
export const inject = ['webServer']

const ROUTE_PATH = '/dsh-local-monitor/sensors.json'
const RESTART_DELAY_MS = 3000
const STALE_AFTER_MS = 6000

export function apply(ctx) {
  const helperPath = fileURLToPath(new URL('./helper.ps1', import.meta.url))

  const state = {
    latest: null,
    latestAt: 0,
    child: null,
    running: false,
    restarts: 0,
    lastError: null,
    recentErrors: [],
    restartTimer: null,
    disposed: false,
  }

  function rememberError(line) {
    const text = String(line === undefined || line === null ? '' : line).trim()
    if (!text) return
    state.lastError = text.slice(0, 400)
    state.recentErrors.push(state.lastError)
    if (state.recentErrors.length > 30) state.recentErrors.shift()
  }

  function powershellPath() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  }

  function scheduleRestart() {
    if (state.disposed || state.restartTimer) return
    state.restarts += 1
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null
      spawnHelper()
    }, RESTART_DELAY_MS)
    if (typeof state.restartTimer.unref === 'function') state.restartTimer.unref()
  }

  function spawnHelper() {
    if (state.disposed) return
    if (process.platform !== 'win32') {
      rememberError('sensor helper needs Windows (GPU-Z shared memory + WMI)')
      return
    }
    let child
    try {
      child = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-ParentPid', String(process.pid)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      rememberError(error && error.message ? error.message : error)
      scheduleRestart()
      return
    }

    state.child = child
    state.running = true

    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index).trim()
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
        if (!line) continue
        try {
          const sample = JSON.parse(line)
          state.latest = sample
          state.latestAt = Date.now()
        } catch (error) {
          rememberError(`unreadable sample: ${line.slice(0, 160)}`)
        }
      }
      if (pending.length > 512 * 1024) pending = ''
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) rememberError(line)
    })

    child.on('error', (error) => {
      rememberError(error && error.message ? error.message : error)
    })

    child.on('exit', (code, signal) => {
      state.running = false
      state.child = null
      if (state.disposed) return
      rememberError(`collector exited (code ${code}${signal ? `, ${signal}` : ''})`)
      scheduleRestart()
    })
  }

  function stopHelper() {
    state.disposed = true
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = null
    }
    const child = state.child
    state.child = null
    state.running = false
    if (child) {
      try {
        child.kill()
      } catch {}
    }
  }

  ctx.effect(() => {
    spawnHelper()
    return () => stopHelper()
  })

  function snapshot() {
    const now = Date.now()
    const age = state.latestAt ? now - state.latestAt : null
    const sample = state.latest
    return {
      ok: Boolean(sample) && age !== null && age < STALE_AFTER_MS,
      ts: now,
      updatedAt: state.latestAt || null,
      ageMs: age,
      gpu: sample ? sample.gpu || null : null,
      cpu: sample ? sample.cpu || null : null,
      mem: sample ? sample.mem || null : null,
      sampleError: sample ? sample.error || null : null,
      diag: sample ? sample.diag || null : null,
      helper: {
        running: state.running,
        restarts: state.restarts,
        lastError: state.lastError || null,
        recentErrors: state.recentErrors.slice(-5),
      },
    }
  }

  /**
   * Local-only read route: sensor numbers are not secret, but nothing outside
   * this machine should be able to poll the Host through it.
   */
  function reject(req) {
    try {
      const headers = req.headers || {}
      const host = String(headers.host || '')
      if (!host) return 403
      let authority
      try {
        authority = new URL(`http://${host}`)
      } catch {
        return 403
      }
      const hostname = authority.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      const loopback =
        hostname === 'localhost' ||
        hostname === '::1' ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
      if (!loopback) return 403
      if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        try {
          if (new URL(origin).host.toLowerCase() !== authority.host.toLowerCase()) return 403
        } catch {
          return 403
        }
      }
      return null
    } catch {
      return 403
    }
  }

  function send(res, status, body) {
    try {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    } catch {}
  }

  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const rejection = reject(req)
      if (rejection !== null) {
        send(res, rejection, { ok: false, error: 'forbidden' })
        return
      }
      send(res, 200, snapshot())
    }
    const dispose = webCtx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler })
    webCtx.effect(() => () => dispose())
  })
}
