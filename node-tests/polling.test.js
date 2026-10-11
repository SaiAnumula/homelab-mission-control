import test from 'node:test'
import assert from 'node:assert/strict'
import { createPoller, deviceStatus, validateTelemetry } from '../src/polling.js'
const data = { devices: [{ id: 'fixture', online: true }] }
function harness(fetcher) {
  const timers = new Map(), events = []; let id = 0
  const poller = createPoller({ fetcher, onData: d => events.push(['data', d]), onError: e => events.push(['error', e]), onLoading: l => events.push(['loading', l]), schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id }, cancel: key => timers.delete(key) })
  return { poller, timers, events }
}
test('manual refresh coalesces with polling and schedules only after completion', async () => {
  let release, calls = 0
  const h = harness(() => { calls++; return new Promise(resolve => { release = resolve }) })
  const a = h.poller.refresh(), b = h.poller.refresh()
  assert.equal(calls, 1); assert.equal(h.timers.size, 1)
  release({ ok: true, json: async () => data }); await Promise.all([a, b])
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 10000)
  assert.deepEqual(h.events.map(e => e[0]), ['loading', 'data', 'loading']); h.poller.stop(); assert.equal(h.timers.size, 0)
})
test('timeout aborts request, reports stale state and allows next poll', async () => {
  const h = harness((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error(), { name: 'AbortError' })))))
  const pending = h.poller.refresh(); [...h.timers.values()][0].fn(); await pending
  assert.match(h.events[1][1], /timed out.*stale/); assert.equal([...h.timers.values()][0].delay, 10000); h.poller.stop()
})
test('unmount aborts and suppresses callbacks and future polls', async () => {
  let release, signal
  const h = harness((_url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve }) })
  const pending = h.poller.refresh(); h.poller.stop(); assert.equal(signal.aborted, true)
  release({ ok: true, json: async () => data }); await pending
  assert.deepEqual(h.events, [['loading', true]]); assert.equal(h.timers.size, 0)
})
test('HTTP and malformed data fail visibly', async () => {
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ devices: null }) }]) {
    const h = harness(async () => response); await h.poller.refresh(); assert.equal(h.events[1][0], 'error'); h.poller.stop()
  }
  assert.throws(() => validateTelemetry({ devices: [null] }))
  for (const malformed of [{ services: [{ name: 'fixture' }] }, { drives: {} }, { containers: [null] }, { specs: { cpu: {} } }]) assert.throws(() => validateTelemetry({ devices: [{ id: 'fixture', online: true, ...malformed }] }))
})
test('status distinguishes down, degraded, stale and fresh up', () => {
  const fixture = { online: true, checkedAt: new Date(100000).toISOString() }
  assert.equal(deviceStatus(fixture, false, 100001), 'up')
  assert.equal(deviceStatus(fixture, true, 100001), 'stale')
  assert.equal(deviceStatus(fixture, false, 125001), 'stale')
  assert.equal(deviceStatus({ ...fixture, online: false }, false, 100001), 'down')
  assert.equal(deviceStatus({ ...fixture, containers: [{ state: 'running', health: 'unhealthy' }] }, false, 100001), 'degraded')
  assert.equal(deviceStatus({ ...fixture, status: 'degraded' }, false, 100001), 'degraded')
})
