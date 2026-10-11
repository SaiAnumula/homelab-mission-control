export function deviceStatus(device, stale = false, now = Date.now()) {
  const checked = Date.parse(device.checkedAt)
  if (stale || !Number.isFinite(checked) || now - checked > 25000) return 'stale'
  if (!device.online) return 'down'
  if (device.status === 'degraded' || device.containers?.some(item => item.state !== 'running' || ['unhealthy', 'starting'].includes(item.health)) || device.services?.some(item => item.state !== 'active')) return 'degraded'
  return 'up'
}
export function validateTelemetry(data) {
  if (!data || !Array.isArray(data.devices) || data.devices.some(device => !device || typeof device.id !== 'string' || typeof device.online !== 'boolean')) throw new Error('Invalid telemetry response')
  for (const device of data.devices) {
    for (const key of ['specs', 'usage']) if (device[key] != null && (typeof device[key] !== 'object' || Array.isArray(device[key]) || Object.values(device[key]).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) throw new Error('Invalid telemetry response')
    for (const key of ['drives', 'containers', 'services']) {
      if (device[key] == null) continue
      if (!Array.isArray(device[key]) || device[key].some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.values(item).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)) || (key !== 'drives' && (typeof item.state !== 'string' || typeof item.name !== 'string')))) throw new Error('Invalid telemetry response')
    }
  }
  return data
}
export function createPoller({ fetcher = fetch, onData, onError, onLoading, interval = 10000, timeout = 6000, schedule = setTimeout, cancel = clearTimeout }) {
  let pending, controller, next, deadline, stopped = false
  const refresh = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    cancel(next)
    controller = new AbortController()
    deadline = schedule(() => controller.abort(), timeout)
    onLoading(true)
    pending = (async () => {
      try {
        // Defer transport execution so even synchronous throws release pending.
        await Promise.resolve()
        const response = await fetcher('/api/devices', { signal: controller.signal })
        if (!response.ok) throw new Error('Telemetry service unavailable')
        const data = validateTelemetry(await response.json())
        if (!stopped) onData(data)
      } catch (error) {
        if (!stopped) onError(error.name === 'AbortError' ? 'Telemetry request timed out; displayed data is stale' : error.message)
      } finally {
        cancel(deadline)
        pending = undefined
        if (!stopped) { onLoading(false); next = schedule(refresh, interval) }
      }
    })()
    return pending
  }
  return { refresh, stop() { stopped = true; cancel(next); cancel(deadline); controller?.abort() } }
}
