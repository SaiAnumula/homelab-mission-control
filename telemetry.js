// Import-safe telemetry helpers. Tests inject collectors; this module never probes hosts.
const fields = (value, names) => Object.fromEntries(names.filter(key => value?.[key] !== undefined).map(key => {
  if (value[key] !== null && !['string', 'number', 'boolean'].includes(typeof value[key])) throw new Error('Invalid telemetry field')
  return [key, value[key]]
}))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function validateDevices(devices) {
  if (!Array.isArray(devices)) throw new Error('Device configuration must be an array')
  const ids = new Set()
  for (const device of devices) {
    if (!object(device) || typeof device.id !== 'string' || !device.id.trim() || typeof device.name !== 'string' || !device.name.trim()) throw new Error('Each device needs an id and name')
    if (ids.has(device.id)) throw new Error('Device ids must be unique')
    ids.add(device.id)
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
  const result = fields(stats, ['online', 'demo', 'os', 'uptime'])
  result.specs = fields(stats.specs, ['cpu', 'cores', 'memory', 'disk', 'gpu', 'vram'])
  result.usage = fields(stats.usage, ['cpu', 'memory', 'disk', 'gpu', 'gpu_vram', 'temperature', 'net_rx_rate', 'net_tx_rate', 'disk_read_rate', 'disk_write_rate'])
  for (const [key, names] of Object.entries({ drives: ['name', 'device', 'model', 'capacity', 'size_bytes', 'mount', 'used_bytes', 'usage', 'health', 'primary'], containers: ['name', 'state', 'status', 'health'], services: ['id', 'name', 'state', 'detail'] })) {
    if (stats[key] !== undefined && (!Array.isArray(stats[key]) || stats[key].some(item => !object(item)))) throw new Error('Invalid telemetry payload')
    result[key] = (stats[key] || []).map(item => {
      if (['containers', 'services'].includes(key) && (typeof item.name !== 'string' || typeof item.state !== 'string')) throw new Error('Invalid telemetry item')
      return fields(item, names)
    })
  }
  // Trusted configuration wins; endpoint and credentials never reach the client.
  return { ...result, ...fields(device, ['id', 'name', 'label', 'type', 'accent']), checkedAt }
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
