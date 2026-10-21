import test from 'node:test'
import assert from 'node:assert/strict'
import { createPoller, deviceStatus, validateTelemetry } from '../src/polling.js'
const data = { devices: [{ id: 'fixture', name: 'Fixture', online: true }] }
function harness(fetcher) {
  const timers = new Map(), events = []; let id = 0
  const poller = createPoller({ fetcher, onData: d => events.push(['data', d]), onError: e => events.push(['error', e]), onLoading: l => events.push(['loading', l]), schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id }, cancel: key => timers.delete(key) })
  return { poller, timers, events }
}
test('manual refresh coalesces with polling and schedules only after completion', async () => {
  let release, calls = 0
  const h = harness(() => { calls++; return new Promise(resolve => { release = resolve }) })
  const a = h.poller.refresh(), b = h.poller.refresh()
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(h.timers.size, 1)
  release({ ok: true, json: async () => data }); await Promise.all([a, b])
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 10000)
  assert.deepEqual(h.events.map(e => e[0]), ['loading', 'data', 'loading']); h.poller.stop(); assert.equal(h.timers.size, 0)
})
test('timeout aborts request, reports stale state and allows next poll', async () => {
  const h = harness((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error(), { name: 'AbortError' })))))
  const pending = h.poller.refresh(); await Promise.resolve(); [...h.timers.values()][0].fn(); await pending
  assert.match(h.events[1][1], /timed out.*stale/); assert.equal([...h.timers.values()][0].delay, 1000); h.poller.stop()
})
test('unmount aborts and suppresses callbacks and future polls', async () => {
  let release, signal
  const h = harness((_url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve }) })
  const pending = h.poller.refresh(); await Promise.resolve(); h.poller.stop(); assert.equal(signal.aborted, true)
  release({ ok: true, json: async () => data }); await pending
  assert.deepEqual(h.events, [['loading', true]]); assert.equal(h.timers.size, 0)
})
test('HTTP and malformed data fail visibly', async () => {
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ devices: null }) }]) {
    const h = harness(async () => response); await h.poller.refresh(); assert.equal(h.events[1][0], 'error'); h.poller.stop()
  }
  assert.throws(() => validateTelemetry({ devices: [null] }))
  for (const malformed of [{ services: [{ name: 'fixture' }] }, { drives: {} }, { containers: [null] }, { specs: { cpu: {} } }]) assert.throws(() => validateTelemetry({ devices: [{ id: 'fixture', name: 'Fixture', online: true, ...malformed }] }))
})
test('status distinguishes down, degraded, stale and fresh up', () => {
  const fixture = { online: true, checkedAt: new Date(100000).toISOString() }
  assert.equal(deviceStatus(fixture, false, 100001), 'up')
  assert.equal(deviceStatus(fixture, true, 100001), 'stale')
  assert.equal(deviceStatus(fixture, false, 135000), 'up')
  assert.equal(deviceStatus(fixture, false, 135001), 'stale')
  assert.equal(deviceStatus({ ...fixture, online: false }, false, 100001), 'down')
  assert.equal(deviceStatus({ ...fixture, containers: [{ state: 'running', health: 'unhealthy' }] }, false, 100001), 'degraded')
  assert.equal(deviceStatus({ ...fixture, collectedAt: new Date(1).toISOString() }, false, 100001), 'stale')
  assert.equal(deviceStatus({ ...fixture, drives: [{ health: 'warning' }] }, false, 100001), 'degraded')
  assert.equal(deviceStatus({ ...fixture, status: 'degraded' }, false, 100001), 'degraded')
})

test('a synchronous transport failure releases pending for manual retry', async () => {
  let calls = 0
  const h = harness(() => { if (!calls++) throw new Error('fixture transport failure'); return Promise.resolve({ ok: true, json: async () => data }) })
  await h.poller.refresh(); assert.equal(h.events[1][0], 'error')
  await h.poller.refresh(); assert.equal(calls, 2); assert.equal(h.events[4][0], 'data'); h.poller.stop()
})

test('recovery snapshots poll quickly and explicit down survives old collection timestamps', async () => {
  for (const status of ['stale', 'down']) {
    const h = harness(async () => ({ ok: true, json: async () => ({ devices: [{ ...data.devices[0], status }] }) }))
    await h.poller.refresh()
    assert.equal([...h.timers.values()][0].delay, status === 'stale' ? 1000 : 10000)
    h.poller.stop()
    const device = { online: false, status, checkedAt: new Date(100000).toISOString(), collectedAt: new Date(0).toISOString() }
    assert.equal(deviceStatus(device, false, 100001), status)
    assert.equal(deviceStatus(device, true, 100001), 'stale')
  }
})

function clockedHarness(respond) {
  let clock = 0
  const timers = new Map(), delays = []; let id = 0
  const poller = createPoller({ fetcher: async () => respond(), onData() {}, onError() {}, onLoading() {}, onSchedule: delay => delays.push(delay), now: () => clock, schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id }, cancel: key => timers.delete(key) })
  return { poller, delays, poll: async at => { clock = at; await poller.refresh() } }
}

test('new problems poll fast, then fall back to the normal interval', async () => {
  let devices = [{ ...data.devices[0], status: 'stale', online: false }]
  const h = clockedHarness(() => ({ ok: true, json: async () => ({ devices }) }))
  await h.poll(0); await h.poll(14999); await h.poll(15000)
  devices = [{ ...data.devices[0], status: 'down', online: false }]; await h.poll(16000)
  devices = [{ ...data.devices[0], status: 'stale', online: false }]; await h.poll(30000)
  devices = data.devices; await h.poll(40000)
  devices = [{ ...data.devices[0], status: 'stale', online: false }]; await h.poll(50000)
  assert.deepEqual(h.delays, [1000, 1000, 10000, 10000, 10000, 10000, 1000])
  h.poller.stop()
})

test('a newly failing device polls fast even while another stays down', async () => {
  let devices = [{ id: 'a', name: 'A', online: false, status: 'down' }]
  const h = clockedHarness(() => ({ ok: true, json: async () => ({ devices }) }))
  await h.poll(0)
  devices = [...devices, { id: 'b', name: 'B', online: false, status: 'stale' }]; await h.poll(10000)
  assert.deepEqual(h.delays, [10000, 1000])
  h.poller.stop()
})

test('request failures poll fast, then fall back to the normal interval', async () => {
  let ok = false
  const h = clockedHarness(() => ok ? { ok: true, json: async () => data } : { ok: false })
  await h.poll(0); await h.poll(14999); await h.poll(15000)
  ok = true; await h.poll(20000)
  ok = false; await h.poll(30000)
  assert.deepEqual(h.delays, [1000, 1000, 10000, 10000, 1000])
  h.poller.stop()
})
