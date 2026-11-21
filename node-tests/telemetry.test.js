import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDevices, createCachedCollector, fetchTelemetry, MAX_HEALTH_BYTES, MAX_TELEMETRY_BYTES, publicDevice, readJson, validateDevices } from '../telemetry.js'
const device = { id: 'fixture', name: 'Fixture', endpoint: 'demo', token: 'fixture-only' }
test('configuration errors fail explicitly before collecting', async () => {
  for (const invalid of [[{ ...device, label: {} }], {}, [device, device], [{ ...device, endpoint: 'file:///fixture' }], [{ ...device, endpoint: 'https://user:password@example.invalid' }]]) assert.throws(() => validateDevices(invalid))
  let calls = 0
  await assert.rejects(collectDevices({}, () => { calls++ }))
  assert.equal(calls, 0)
})
test('public response excludes credentials and honors configured identity', () => {
  const result = publicDevice(device, { online: true, id: 'spoofed', name: 'spoofed', token: 'secret', endpoint: 'secret', usage: { cpu: 5, token: 'secret' } }, 'fixture-time')
  assert.equal(result.id, 'fixture'); assert.equal(result.name, 'Fixture')
  assert.equal(result.token, undefined); assert.equal(result.endpoint, undefined)
  assert.deepEqual(result.usage, { cpu: 5 })
})
test('invalid payload and failed probes produce isolated down states without leaked error details', async () => {
  const result = await collectDevices([device], async () => { throw new Error('secret URL') }, () => 'fixture-time')
  assert.equal(result[0].online, false); assert.equal(result[0].checkedAt, 'fixture-time')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  for (const stats of [null, { online: true, uptime: NaN }, { online: 'yes' }, { online: true, containers: {} }, { online: true, services: [{ name: 'fixture' }] }, { online: true, specs: { cpu: {} } }, { online: true, usage: { cpu: 'high' } }]) assert.throws(() => publicDevice(device, stats))
})
test('concurrent requests share collection and TTL limits repeated probes', async () => {
  let calls = 0, clock = 0, release
  const cached = createCachedCollector(() => { calls++; return new Promise(resolve => { release = resolve }) }, { now: () => clock })
  const a = cached(), b = cached()
  await Promise.resolve(); assert.equal(calls, 1)
  release('data'); assert.equal(await a, 'data'); assert.equal(await b, 'data')
  clock = 9999; assert.equal(await cached(), 'data'); assert.equal(calls, 1)
  clock = 10000; const c = cached(); await Promise.resolve(); release('new'); assert.equal(await c, 'new'); assert.equal(calls, 2)
})
test('failed collections can retry without poisoning cache', async () => {
  let calls = 0
  const cached = createCachedCollector(async () => { if (!calls++) throw Error('fixture'); return 'recovered' })
  await assert.rejects(cached()); assert.equal(await cached(), 'recovered')
})

test('a failing docker collector degrades instead of reading as zero containers', () => {
  const base = { online: true, usage: { cpu: 5 }, containers: [] }
  for (const healthy of ['ok', 'absent']) {
    const result = publicDevice(device, { ...base, docker_status: healthy })
    assert.equal(result.status, 'up'); assert.equal(result.docker_status, healthy)
  }
  const failed = publicDevice(device, { ...base, docker_status: 'error', error: 'Docker status check failed' })
  assert.equal(failed.status, 'degraded')
  assert.equal(failed.docker_status, 'error')
  assert.equal(failed.error, 'Docker status check failed')
  assert.equal(publicDevice(device, { ...base, error: 'Docker status unavailable' }).status, 'degraded')
  assert.equal(publicDevice(device, { ...base, error: null }).status, 'up')
  for (const invalid of [{ ...base, docker_status: 5 }, { ...base, error: 5 }]) assert.throws(() => publicDevice(device, invalid))
})

const streamOf = (...chunks) => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } })
const timeoutError = () => Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' })

test('remote telemetry caps the response body like the python dashboard', async () => {
  const payload = '{"online":true}'
  // A body at exactly the limit parses; one byte over is rejected.
  const exact = await readJson({ ok: true, body: streamOf(new TextEncoder().encode(payload)) }, payload.length)
  assert.equal(exact.online, true)
  await assert.rejects(readJson({ ok: true, body: streamOf(new TextEncoder().encode(payload)) }, payload.length - 1), /size limit/)

  // The full 1 MiB stats ceiling applies to a chunked stream, stops reading
  // instead of buffering, and is never retried like a timeout would be.
  const body = 'x'.repeat(MAX_TELEMETRY_BYTES + 1)
  let calls = 0, cancelled = false
  const fetchFn = async () => {
    calls++
    return { ok: true, body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)) },
      cancel() { cancelled = true },
    }) }
  }
  await assert.rejects(fetchTelemetry('http://fixture.example/api/agent/stats', { fetchFn }), /size limit/)
  assert.equal(calls, 1)
  assert.equal(cancelled, true)

  // Responses without a stream body (for example a 204) get the same ceiling.
  await assert.rejects(readJson({ ok: true, body: null, text: async () => body }, MAX_TELEMETRY_BYTES), /size limit/)
  const textOnly = await readJson({ ok: true, body: null, text: async () => payload }, MAX_TELEMETRY_BYTES)
  assert.equal(textOnly.online, true)
})

test('a transient timeout retries exactly once with a shorter timeout', async () => {
  const durations = []
  const timeoutSignal = ms => { durations.push(ms); return AbortSignal.timeout(ms) }
  let calls = 0
  const fetchFn = async () => {
    if (!calls++) throw timeoutError()
    return { ok: true, body: streamOf(new TextEncoder().encode('{"online":true}')) }
  }
  const result = await fetchTelemetry('http://fixture.example/api/agent/stats', { fetchFn, timeoutSignal })
  assert.equal(result.online, true)
  assert.equal(calls, 2)
  assert.deepEqual(durations, [4000, 3000])
})

test('a persistent timeout stops after one retry and other failures never retry', async () => {
  const durations = []
  const timeoutSignal = ms => { durations.push(ms); return AbortSignal.timeout(ms) }
  let calls = 0
  await assert.rejects(fetchTelemetry('http://fixture.example/api/agent/stats', {
    fetchFn: async () => { calls++; throw timeoutError() }, timeoutSignal,
  }), error => error.name === 'TimeoutError')
  assert.equal(calls, 2)
  assert.deepEqual(durations, [4000, 3000])

  durations.length = 0
  for (const failure of [async () => { throw new Error('secret fixture URL') }, async () => ({ ok: false, status: 500 })]) {
    let attempts = 0
    await assert.rejects(fetchTelemetry('http://fixture.example/api/agent/stats', {
      fetchFn: async () => { attempts++; return failure() }, timeoutSignal,
    }), /secret fixture URL|Telemetry unavailable/)
    assert.equal(attempts, 1)
  }
  assert.deepEqual(durations, [4000, 4000])  // one signal per failure; no second attempt
})

test('health checks stay single attempt with a 16 KiB ceiling', async () => {
  assert.equal(MAX_HEALTH_BYTES, 16 * 1024)
  const durations = []
  const timeoutSignal = ms => { durations.push(ms); return AbortSignal.timeout(ms) }
  let calls = 0
  await assert.rejects(fetchTelemetry('http://fixture.example/api/health', {
    timeouts: [1000], maxBytes: MAX_HEALTH_BYTES, timeoutSignal,
    fetchFn: async () => { calls++; throw timeoutError() },
  }), error => error.name === 'TimeoutError')
  assert.equal(calls, 1)  // health is one attempt; only stats get the retry
  assert.deepEqual(durations, [1000])
  const payload = await fetchTelemetry('http://fixture.example/api/health', {
    timeouts: [1000], maxBytes: MAX_HEALTH_BYTES, timeoutSignal,
    fetchFn: async () => ({ ok: true, body: streamOf(new TextEncoder().encode('{"ok":true}')) }),
  })
  assert.equal(payload.ok, true)
  await assert.rejects(fetchTelemetry('http://fixture.example/api/health', {
    timeouts: [1000], maxBytes: MAX_HEALTH_BYTES, timeoutSignal,
    fetchFn: async () => ({ ok: true, body: streamOf(new TextEncoder().encode('x'.repeat(MAX_HEALTH_BYTES + 1))) }),
  }), /size limit/)
})
