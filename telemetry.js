// Import-safe telemetry helpers. Nothing runs at import time; tests inject collectors and commands.
import { performance } from 'node:perf_hooks'
import { setInterval, clearInterval } from 'node:timers'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
const execFileAsync = promisify(execFileCallback)
const fields = (value, names) => Object.fromEntries(names.filter(key => value?.[key] !== undefined).map(key => {
  if (value[key] !== null && !['string', 'number', 'boolean'].includes(typeof value[key])) throw new Error('Invalid telemetry field')
  return [key, value[key]]
}))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function validateDevices(devices) {
  if (!Array.isArray(devices) || devices.length > 64) throw new Error('Device configuration must be an array')
  const ids = new Set()
  for (const device of devices) {
    if (!object(device) || typeof device.id !== 'string' || !device.id.trim() || typeof device.name !== 'string' || !device.name.trim()) throw new Error('Each device needs an id and name')
    if (ids.has(device.id)) throw new Error('Device ids must be unique')
    ids.add(device.id)
    for (const key of ['label', 'type', 'accent']) if (device[key] !== undefined && typeof device[key] !== 'string') throw new Error('Invalid device display field')
    if (!['local', 'demo'].includes(device.endpoint)) {
      let url
      try { url = new URL(device.endpoint) } catch { throw new Error('Invalid device endpoint') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid device endpoint')
    }
    if (device.token !== undefined && typeof device.token !== 'string') throw new Error('Invalid device token')
  }
  return devices
}
export function publicDevice(device, stats, checkedAt) {
  if (!object(stats) || typeof stats.online !== 'boolean') throw new Error('Invalid telemetry payload')
  for (const key of ['specs', 'usage']) if (stats[key] !== undefined && !object(stats[key])) throw new Error('Invalid telemetry payload')
  const result = fields(stats, ['online', 'status', 'demo', 'os', 'uptime', 'collectedAt', 'error', 'docker_status'])
  for (const key of ['error', 'docker_status']) if (result[key] != null && typeof result[key] !== 'string') throw new Error('Invalid telemetry payload')
  if (result.uptime != null && (!Number.isFinite(result.uptime) || result.uptime < 0)) throw new Error('Invalid telemetry uptime')
  result.specs = fields(stats.specs, ['cpu', 'cores', 'memory', 'disk', 'gpu', 'vram'])
  result.usage = fields(stats.usage, ['cpu', 'memory', 'disk', 'gpu', 'gpu_vram', 'temperature', 'net_rx_rate', 'net_tx_rate', 'disk_read_rate', 'disk_write_rate'])
  for (const value of Object.values(result.specs)) if (value !== null && typeof value !== 'string') throw new Error('Invalid telemetry specs')
  for (const [key, value] of Object.entries(result.usage)) {
    if (value !== null && (key.endsWith('_rate') ? typeof value !== 'string' : !Number.isFinite(value))) throw new Error('Invalid telemetry usage')
  }
  for (const [key, names] of Object.entries({ drives: ['name', 'device', 'model', 'capacity', 'size_bytes', 'mount', 'used_bytes', 'usage', 'health', 'primary'], containers: ['name', 'state', 'status', 'health'], services: ['id', 'name', 'state', 'detail'] })) {
    if (stats[key] !== undefined && (!Array.isArray(stats[key]) || stats[key].some(item => !object(item)))) throw new Error('Invalid telemetry payload')
    result[key] = (stats[key] || []).map(item => {
      if (['containers', 'services'].includes(key) && (typeof item.name !== 'string' || typeof item.state !== 'string')) throw new Error('Invalid telemetry item')
      return fields(item, names)
    })
  }
  // Trusted configuration wins; endpoint and credentials never reach the client.
  // A failing Docker collector must be visible, not read as zero containers.
  const degraded = result.error != null || result.docker_status === 'error' || result.drives.some(item => ['warning', 'failing'].includes(item.health)) || result.containers.some(item => item.state !== 'running' || ['unhealthy', 'starting'].includes(item.health)) || result.services.some(item => item.state !== 'active')
  return { ...result, ...fields(device, ['id', 'name', 'label', 'type', 'accent']), online: stats.online, status: !result.online ? 'down' : degraded ? 'degraded' : 'up', checkedAt }
}
export function createCachedCollector(collect, { ttl = 10000, now = Date.now } = {}) {
  let cached, expires = 0, pending
  return () => {
    if (pending) return pending
    if (cached && now() < expires) return Promise.resolve(cached)
    pending = Promise.resolve().then(collect).then(value => { cached = value; expires = now() + ttl; return value }).finally(() => { pending = undefined })
    return pending
  }
}
export async function collectDevices(devices, collect, now = () => new Date().toISOString()) {
  return Promise.all(validateDevices(devices).map(async (device, index) => {
    try { return publicDevice(device, await collect(device, index), now()) }
    catch { return { ...fields(device, ['id', 'name', 'label', 'type', 'accent']), online: false, error: 'Telemetry unavailable', usage: {}, specs: {}, checkedAt: now() } }
  }))
}

// Byte ceilings matching the Python dashboard: 1 MiB stats, 16 KiB health.
export const MAX_TELEMETRY_BYTES = 1024 * 1024
export const MAX_HEALTH_BYTES = 16 * 1024

export async function readJson(response, maxBytes) {
  let bytes
  const reader = response.body?.getReader?.()
  if (reader) {
    const chunks = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        // Stop reading and release the connection instead of buffering a huge body.
        await reader.cancel().catch(() => {})
        throw new Error('Telemetry response exceeds size limit')
      }
      chunks.push(value)
    }
    let offset = 0
    bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  } else {
    bytes = new TextEncoder().encode(await response.text())
    if (bytes.byteLength > maxBytes) throw new Error('Telemetry response exceeds size limit')
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function fetchTelemetry(url, { fetchFn = fetch, timeouts = [4000, 3000], maxBytes = MAX_TELEMETRY_BYTES, headers = {}, timeoutSignal = ms => AbortSignal.timeout(ms) } = {}) {
  let error
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    try {
      const response = await fetchFn(url, { signal: timeoutSignal(timeouts[attempt]), redirect: 'error', headers })
      if (!response.ok) throw new Error('Telemetry unavailable')
      return await readJson(response, maxBytes)
    } catch (caught) {
      error = caught
      // Only a timeout retries, exactly once; other failures surface immediately.
      if (caught?.name !== 'TimeoutError' || attempt === timeouts.length - 1) throw error
    }
  }
  throw error
}

export const DOCKER_PROBE_TIMEOUT_MS = 4000

// Optional Docker monitoring mirrors agent/telemetry_agent.py: an absent CLI is
// a supported configuration, but an installed Docker whose daemon cannot be
// read must stay visible. systeminformation resolves an unreachable daemon to
// [] instead of rejecting, so the Node collector probes the CLI directly with
// a bounded command and maps every failure to a fixed, sanitized message.
export async function dockerCliInstalled({ env = process.env } = {}) {
  const name = process.platform === 'win32' ? 'docker.exe' : 'docker'
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    try {
      await fs.access(path.join(dir, name), fsConstants.X_OK)
      return true
    } catch { /* keep searching PATH */ }
  }
  return false
}

export async function collectDockerContainers({ exec = execFileAsync, env = process.env, timeout = DOCKER_PROBE_TIMEOUT_MS } = {}) {
  let stdout
  try {
    ({ stdout } = await exec('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout, env }))
  } catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('Docker status check timed out', { cause: error })
    if (error?.code === 'ENOENT') throw new Error('Docker status check failed to run', { cause: error })
    throw new Error('Docker status check failed', { cause: error })
  }
  const containers = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let item
    try { item = JSON.parse(line) } catch { throw new Error('Docker status check returned invalid data') }
    if (!object(item) || [item.Names, item.State, item.Status].some(value => typeof value !== 'string')) throw new Error('Docker status check returned invalid data')
    const health = item.Status.includes('(healthy)') ? 'healthy' : item.Status.includes('(unhealthy)') ? 'unhealthy' : item.Status.includes('(health: starting)') ? 'starting' : null
    containers.push({ name: item.Names, state: item.State.toLowerCase(), status: item.Status, health })
  }
  return containers
}

const HEALTHY_CHECK_MS = 10000
// Failing devices retry quickly at first, then settle at a fixed slower rate.
const FAST_RETRY_MS = 1000
const FAST_RETRY_WINDOW_MS = 10000
const SLOW_RETRY_MS = 15000
const DOWN_AFTER_MS = 10000

export function createDeviceMonitor({ collect, health, now = () => performance.now(), stamp = () => new Date().toISOString(), maxWorkers = 8, schedule = setInterval, cancel = clearInterval }) {
  /** @typedef {{device: any, index: number, lastGood: ReturnType<typeof publicDevice> | null, failedSince: number | null, recoveringSince: number | null, recovering: boolean, pending: boolean, due: number, checkedAt?: string, error?: string}} Entry */
  /** @type {Map<string, Entry>} */
  let entries = new Map()
  let active = 0, timer
  /** @param {Entry} entry */
  const isDown = entry => entry.failedSince !== null && now() - entry.failedSince >= DOWN_AFTER_MS
  /** @param {Entry} entry */
  const nextDelay = entry => !entry.recovering ? HEALTHY_CHECK_MS : now() - (entry.recoveringSince ?? now()) < FAST_RETRY_WINDOW_MS ? FAST_RETRY_MS : SLOW_RETRY_MS
  /** @param {Entry} entry */
  const collectEntry = async entry => {
    let reachable = false, result, retryCollection = !entry.recovering
    try {
      if (entry.recovering) {
        const healthResult = await health(entry.device)
        reachable = healthResult === true
        retryCollection = reachable || healthResult === null
        if (reachable) entry.failedSince = null
      }
      if (retryCollection) result = publicDevice(entry.device, await collect(entry.device, entry.index), stamp())
    } catch { /* Public errors below never include endpoint details. */ }
    entry.checkedAt = stamp()
    if (result?.online) {
      entry.lastGood = result
      entry.recovering = false
      entry.recoveringSince = null
      entry.failedSince = null
      entry.error = undefined
    } else {
      entry.recovering = true
      entry.recoveringSince ??= now()
      entry.error = reachable ? 'Telemetry delayed; device responds to health checks' : 'Telemetry unavailable; checking connection'
      if (!reachable && entry.failedSince === null) entry.failedSince = now()
    }
    // Timing from completion keeps checks behind collector caches of the same TTL.
    entry.due = now() + nextDelay(entry)
  }
  /** @param {Entry} entry */
  const check = async entry => {
    try {
      await collectEntry(entry)
    } catch {
      entry.recovering = true
      entry.recoveringSince ??= now()
      entry.error = 'Telemetry check failed'
      entry.failedSince ??= now()
      entry.due = now() + nextDelay(entry)
    } finally {
      entry.pending = false
      active--
    }
  }
  const runDue = () => {
    const due = [...entries.values()].filter(entry => !entry.pending && entry.due <= now()).sort((a, b) => a.due - b.due)
    const jobs = due.slice(0, Math.max(0, maxWorkers - active)).map(entry => {
      entry.pending = true
      active++
      return check(entry)
    })
    return Promise.all(jobs)
  }
  return {
    get(devices) {
      validateDevices(devices)
      const next = new Map()
      for (const [index, device] of devices.entries()) {
        let entry = entries.get(device.id)
        if (!entry || entry.device.endpoint !== device.endpoint) entry = { device: { ...device }, index, lastGood: null, failedSince: null, recoveringSince: null, recovering: false, pending: false, due: 0, checkedAt: undefined, error: 'Waiting for first telemetry check' }
        entry.device = { ...device }
        entry.index = index
        next.set(device.id, entry)
      }
      entries = next
      const results = [...entries.values()].map(entry => {
        /** @type {Record<string, any>} */
        const result = { online: false, specs: {}, usage: {}, ...entry.lastGood, ...fields(entry.device, ['id', 'name', 'label', 'type', 'accent']), checkedAt: entry.checkedAt }
        if (entry.recovering || !entry.lastGood) {
          result.status = isDown(entry) ? 'down' : 'stale'
          if (result.status === 'down') result.online = false
          result.error = entry.error
          result.lastGoodAt = entry.lastGood?.checkedAt
        }
        return result
      })
      return { devices: results, updatedAt: stamp() }
    },
    runDue,
    start() { timer ??= schedule(() => { void runDue() }, 100) },
    stop() { cancel(timer); timer = undefined },
  }
}
