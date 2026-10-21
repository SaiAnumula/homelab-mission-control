// Import-safe telemetry helpers. Tests inject collectors; this module never probes hosts.
import { performance } from 'node:perf_hooks'
import { setInterval, clearInterval } from 'node:timers'
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
  const result = fields(stats, ['online', 'status', 'demo', 'os', 'uptime', 'collectedAt'])
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
  const degraded = result.drives.some(item => ['warning', 'failing'].includes(item.health)) || result.containers.some(item => item.state !== 'running' || ['unhealthy', 'starting'].includes(item.health)) || result.services.some(item => item.state !== 'active')
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
