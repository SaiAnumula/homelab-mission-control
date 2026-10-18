import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceMonitor } from '../telemetry.js'

const device = { id: 'pc', name: 'PC', endpoint: 'http://pc.example', token: 'private-token' }
function harness() {
  let clock = 0, fail = false, reachable = false, calls = 0, healthCalls = 0
  const monitor = createDeviceMonitor({
    collect: async () => { calls++; if (fail) throw Error('private endpoint'); return { online: true, usage: { cpu: 7 } } },
    health: async () => { healthCalls++; return reachable },
    now: () => clock,
    stamp: () => new Date(clock).toISOString(),
  })
  const snapshot = (devices = [device]) => monitor.get(devices).devices[0]
  snapshot()
  return { monitor, snapshot, check: async at => { clock = at; await monitor.runDue() }, setClock: at => { clock = at }, fail: () => { fail = true }, recover: () => { fail = false; reachable = true }, healthOnly: () => { reachable = true }, calls: () => calls, healthCalls: () => healthCalls }
}

test('initial and concurrent browser reads never start duplicate collectors', async () => {
  const h = harness()
  assert.equal(h.snapshot().status, 'stale')
  assert.equal(h.calls(), 0)
  const work = h.monitor.runDue()
  for (let i = 0; i < 20; i++) { h.snapshot(); await h.monitor.runDue() }
  await work
  assert.equal(h.calls(), 1)
  assert.equal(h.snapshot().status, 'up')
  await h.check(9999); assert.equal(h.calls(), 1)
  await h.check(10000); assert.equal(h.calls(), 2)
  assert.equal(JSON.stringify(h.snapshot()).includes('private-token'), false)
})

test('a brief outage keeps old metrics stale and health success immediately refreshes', async () => {
  const h = harness()
  await h.check(0)
  h.fail(); await h.check(10000)
  assert.equal(h.snapshot().status, 'stale')
  assert.deepEqual(h.snapshot().usage, { cpu: 7 })
  assert.equal(h.snapshot().lastGoodAt, new Date(0).toISOString())
  await h.check(10999); assert.equal(h.healthCalls(), 0)
  h.recover(); await h.check(11000)
  assert.equal(h.healthCalls(), 1)
  assert.equal(h.calls(), 3)
  assert.equal(h.snapshot().status, 'up')
})

test('down begins at ten seconds and probes back off to fifteen seconds', async () => {
  const h = harness()
  h.fail(); await h.check(0)
  for (let second = 1; second < 10; second++) await h.check(second * 1000)
  h.setClock(9999); assert.equal(h.snapshot().status, 'stale')
  h.setClock(10000); assert.equal(h.snapshot().status, 'down')
  await h.check(10000); assert.equal(h.healthCalls(), 10)
  await h.check(24999); assert.equal(h.healthCalls(), 10)
  h.recover(); await h.check(25000)
  assert.equal(h.snapshot().status, 'up')
})

test('reachable agents with unavailable metrics stay stale rather than down', async () => {
  const h = harness()
  h.fail(); await h.check(0); h.healthOnly()
  for (let second = 1; second <= 12; second++) await h.check(second * 1000)
  assert.equal(h.snapshot().status, 'stale')
  assert.match(h.snapshot().error, /responds to health/)
})

test('persistently failing metrics retry fast, then settle at fifteen seconds', async () => {
  const h = harness()
  h.fail(); await h.check(0); h.healthOnly()
  for (let second = 1; second <= 10; second++) await h.check(second * 1000)
  assert.equal(h.healthCalls(), 10)
  await h.check(24999); assert.equal(h.healthCalls(), 10)
  await h.check(25000); assert.equal(h.healthCalls(), 11)
  assert.equal(h.snapshot().status, 'stale')
})

test('the next check is timed from completion so collector caches stay expired', async () => {
  let clock = 0, calls = 0
  const monitor = createDeviceMonitor({ collect: async () => { calls++; clock += 3000; return { online: true } }, health: async () => null, now: () => clock })
  monitor.get([device]); await monitor.runDue()
  clock = 12999; await monitor.runDue(); assert.equal(calls, 1)
  clock = 13000; await monitor.runDue(); assert.equal(calls, 2)
})

test('worker cap applies across configuration replacement and in-flight checks', async () => {
  let calls = 0
  const releases = []
  const monitor = createDeviceMonitor({ collect: () => { calls++; return new Promise(resolve => releases.push(() => resolve({ online: true }))) }, health: async () => false })
  const devices = Array.from({ length: 12 }, (_, i) => ({ ...device, id: String(i) }))
  monitor.get(devices)
  const first = monitor.runDue()
  assert.equal(calls, 8)
  monitor.get(devices.map(d => ({ ...d, name: 'Renamed' })))
  await monitor.runDue()
  assert.equal(calls, 8)
  releases.splice(0).forEach(release => release()); await first
  const rest = monitor.runDue()
  assert.equal(calls, 12)
  releases.splice(0).forEach(release => release()); await rest
  assert.equal(monitor.get(devices).devices.every(d => d.status === 'up'), true)
  assert.equal(monitor.get([]).devices.length, 0)
})

test('changed endpoint discards old results, and local collectors can retry', async () => {
  let release
  const monitor = createDeviceMonitor({ collect: () => new Promise(resolve => { release = resolve }), health: async () => true })
  monitor.get([device]); const first = monitor.runDue()
  const replacement = { ...device, endpoint: 'http://new.example' }
  monitor.get([replacement]); release({ online: true }); await first
  assert.equal(monitor.get([replacement]).devices[0].status, 'stale')

  let fail = true, clock = 0
  const local = createDeviceMonitor({ collect: async () => { if (fail) throw Error('fixture'); return { online: true } }, health: async () => null, now: () => clock })
  local.get([{ ...device, endpoint: 'local' }]); await local.runDue()
  clock = 1000; fail = false; await local.runDue()
  assert.equal(local.get([{ ...device, endpoint: 'local' }]).devices[0].status, 'up')
})

test('replacing endpoints cannot bypass the global worker cap', async () => {
  let calls = 0
  const releases = []
  const monitor = createDeviceMonitor({ collect: () => { calls++; return new Promise(resolve => releases.push(() => resolve({ online: true }))) }, health: async () => false })
  const devices = Array.from({ length: 8 }, (_, i) => ({ ...device, id: String(i) }))
  monitor.get(devices); const first = monitor.runDue()
  const replacement = devices.map(d => ({ ...d, endpoint: 'http://new.example' }))
  monitor.get(replacement); await monitor.runDue()
  assert.equal(calls, 8)
  releases.splice(0).forEach(release => release()); await first
  const second = monitor.runDue(); assert.equal(calls, 16)
  releases.splice(0).forEach(release => release()); await second
  assert.equal(monitor.get(replacement).devices.every(d => d.status === 'up'), true)
})

test('unexpected state update errors release worker capacity for recovery', async () => {
  let clock = 0, errors = 0
  const monitor = createDeviceMonitor({ collect: async () => ({ online: true }), health: async () => true, now: () => clock, stamp: () => { if (errors-- > 0) throw Error('fixture formatting'); return new Date(clock).toISOString() }, maxWorkers: 1 })
  monitor.get([device]); errors = 2
  await monitor.runDue()
  assert.equal(monitor.get([device]).devices[0].status, 'stale')
  clock = 1000; await monitor.runDue()
  assert.equal(monitor.get([device]).devices[0].status, 'up')
})

test('start and stop register and remove one background timer', async () => {
  const timers = new Map()
  let id = 0, calls = 0
  const monitor = createDeviceMonitor({ collect: async () => { calls++; return { online: true } }, health: async () => false, schedule: (fn, delay) => { assert.equal(delay, 100); timers.set(++id, fn); return id }, cancel: key => timers.delete(key) })
  monitor.get([device]); monitor.start(); monitor.start()
  assert.equal(timers.size, 1)
  const tick = [...timers.values()][0]; tick()
  await monitor.runDue()
  assert.equal(calls, 1)
  monitor.stop(); assert.equal(timers.size, 0)
  monitor.start(); assert.equal(timers.size, 1)
  monitor.stop(); assert.equal(timers.size, 0)
})

test('collectors receive the configured device index for varied demo metrics', async () => {
  const indices = []
  const monitor = createDeviceMonitor({ collect: async (_device, index) => { indices.push(index); return { online: true } }, health: async () => null })
  monitor.get([device, { ...device, id: 'other' }]); await monitor.runDue()
  assert.deepEqual(indices, [0, 1])
})
