import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDevices, createCachedCollector, publicDevice, validateDevices } from '../telemetry.js'
const device = { id: 'fixture', name: 'Fixture', endpoint: 'demo', token: 'fixture-only' }
test('configuration errors fail explicitly before collecting', async () => {
  for (const invalid of [{}, [device, device], [{ ...device, endpoint: 'file:///fixture' }], [{ ...device, endpoint: 'https://user:password@example.invalid' }]]) assert.throws(() => validateDevices(invalid))
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
  for (const stats of [null, { online: 'yes' }, { online: true, containers: {} }]) assert.throws(() => publicDevice(device, stats))
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
