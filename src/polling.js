// Allows for one missed 10s collection plus browser and server poll offsets.
const FRESHNESS_MS = 35000
export function deviceStatus(device, stale = false, now = Date.now()) {
  const checked = Date.parse(device.checkedAt)
  const collected = device.collectedAt ? Date.parse(device.collectedAt) : checked
  if (stale || device.status === 'stale') return 'stale'
  if (device.status === 'down') return 'down'
  if (!Number.isFinite(checked) || !Number.isFinite(collected) || now - Math.min(checked, collected) > FRESHNESS_MS) return 'stale'
  if (!device.online) return 'down'
  if (device.status === 'degraded' || device.drives?.some(item => ['warning', 'failing'].includes(item.health)) || device.containers?.some(item => item.state !== 'running' || ['unhealthy', 'starting'].includes(item.health)) || device.services?.some(item => item.state !== 'active')) return 'degraded'
  return 'up'
}
export function validateTelemetry(data) {
  if (!data || !Array.isArray(data.devices) || data.devices.some(device => !device || typeof device.id !== 'string' || typeof device.name !== 'string' || (device.os != null && typeof device.os !== 'string') || typeof device.online !== 'boolean')) throw new Error('Invalid telemetry response')
  for (const device of data.devices) {
    for (const key of ['specs', 'usage']) if (device[key] != null && (typeof device[key] !== 'object' || Array.isArray(device[key]) || Object.values(device[key]).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) throw new Error('Invalid telemetry response')
    for (const key of ['drives', 'containers', 'services']) {
      if (device[key] == null) continue
      if (!Array.isArray(device[key]) || device[key].some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.values(item).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)) || (key !== 'drives' && (typeof item.state !== 'string' || typeof item.name !== 'string')))) throw new Error('Invalid telemetry response')
    }
  }
  return data
}
const hasProblem = device => ['stale', 'down'].includes(device.status) || !device.online
export function createPoller({ fetcher = fetch, onData, onError, onLoading, onSchedule, interval = 10000, fastInterval = 1000, fastWindow = 15000, timeout = 6000, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let pending, controller, next, deadline, errorSince, stopped = false
  // When each problem was first seen: new problems poll fast, lasting ones fall back to the normal interval.
  let problemSince = new Map()
  const refresh = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    cancel(next)
    controller = new AbortController()
    deadline = schedule(() => controller.abort(), timeout)
    onLoading(true)
    pending = (async () => {
      let delay = interval
      try {
        // Defer transport execution so even synchronous throws release pending.
        await Promise.resolve()
        const response = await fetcher('/api/devices', { signal: controller.signal })
        if (!response.ok) throw new Error('Telemetry service unavailable')
        const data = validateTelemetry(await response.json())
        const at = now()
        problemSince = new Map(data.devices.filter(hasProblem).map(device => [device.id, problemSince.get(device.id) ?? at]))
        errorSince = undefined
        // Down devices are only rechecked slowly by the server, so they never need fast polling.
        if (data.devices.some(device => hasProblem(device) && device.status !== 'down' && at - problemSince.get(device.id) < fastWindow)) delay = fastInterval
        if (!stopped) onData(data)
      } catch (error) {
        errorSince ??= now()
        if (now() - errorSince < fastWindow) delay = fastInterval
        if (!stopped) onError(error.name === 'AbortError' ? 'Telemetry request timed out; displayed data is stale' : error.message)
      } finally {
        cancel(deadline)
        pending = undefined
        if (!stopped) { onLoading(false); onSchedule?.(delay); next = schedule(refresh, delay) }
      }
    })()
    return pending
  }
  return { refresh, stop() { stopped = true; cancel(next); cancel(deadline); controller?.abort() } }
}
