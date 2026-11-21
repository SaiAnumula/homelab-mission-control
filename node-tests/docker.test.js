import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDockerContainers, dockerCliInstalled, publicDevice } from '../telemetry.js'

const device = { id: 'fixture', name: 'Fixture', endpoint: 'demo' }
const base = { online: true, usage: { cpu: 5 }, containers: [] }

test('an installed docker with an unreachable daemon reports an error, not healthy emptiness', async () => {
  // Real reproduction of a dead or missing daemon: the docker CLI is invoked
  // exactly like the collector does, with DOCKER_HOST pointing at a socket
  // that cannot exist. systeminformation would resolve this to []; the
  // bounded CLI probe must reject instead.
  const env = { ...process.env, DOCKER_HOST: 'unix:///nonexistent/qa-test.sock' }
  const error = await collectDockerContainers({ env }).then(() => null, caught => caught)
  assert.ok(error, 'an unreachable daemon must not resolve to a container list')
  assert.ok(
    ['Docker status check failed', 'Docker status check failed to run', 'Docker status check timed out'].includes(error.message),
    `unexpected probe message: ${error.message}`,
  )
  // The message is fixed and sanitized: no socket path, no CLI stderr.
  assert.equal(/qa-test|sock|daemon|stderr/.test(error.message), false)

  // What server.js localStats builds from a rejected probe must degrade.
  const degraded = publicDevice(device, { ...base, docker_status: 'error', error: error.message })
  assert.equal(degraded.docker_status, 'error')
  assert.equal(degraded.error, error.message)
  assert.equal(degraded.status, 'degraded')

  // The same failure reproduced through the collector path, end to end:
  // a probe against the nonexistent socket while the CLI really is installed.
  if (await dockerCliInstalled()) {
    assert.equal(error.message, 'Docker status check failed')
  }
})

test('an absent docker cli and an idle healthy daemon are not degraded', async () => {
  // No docker binary on PATH: a supported configuration, not a failure.
  assert.equal(await dockerCliInstalled({ env: { ...process.env, PATH: '' } }), false)
  assert.equal(publicDevice(device, { ...base, docker_status: 'absent' }).status, 'up')

  // A daemon that answers with zero containers is healthy, not broken.
  const idle = await collectDockerContainers({ exec: async () => ({ stdout: '' }) })
  assert.deepEqual(idle, [])
  assert.equal(publicDevice(device, { ...base, docker_status: 'ok', containers: idle }).status, 'up')
})

test('probe failures map to fixed sanitized messages', async () => {
  const cases = [
    [Object.assign(new Error('fixture'), { killed: true }), 'Docker status check timed out'],
    [Object.assign(new Error('fixture'), { code: 'ETIMEDOUT' }), 'Docker status check timed out'],
    [Object.assign(new Error('fixture'), { code: 'ENOENT' }), 'Docker status check failed to run'],
    [Object.assign(new Error('Cannot connect to the Docker daemon at unix:///secret/host.sock'), { code: 1 }), 'Docker status check failed'],
  ]
  for (const [failure, message] of cases) {
    await assert.rejects(collectDockerContainers({ exec: async () => { throw failure } }), { message })
  }
  await assert.rejects(collectDockerContainers({ exec: async () => ({ stdout: 'not json\n' }) }), { message: 'Docker status check returned invalid data' })
  await assert.rejects(collectDockerContainers({ exec: async () => ({ stdout: `${JSON.stringify({ Names: 5 })}\n` }) }), { message: 'Docker status check returned invalid data' })
})

test('docker ps output maps to the dashboard container shape', async () => {
  const stdout = [
    JSON.stringify({ Names: 'immich_server', State: 'Running', Status: 'Up 2 hours (healthy)' }),
    JSON.stringify({ Names: 'plex', State: 'Exited', Status: 'Exited (0) 3 minutes ago' }),
    JSON.stringify({ Names: 'fresh', State: 'Restarting', Status: 'Restarting (1) 4 seconds ago (health: starting)' }),
    '',
  ].join('\n')
  const containers = await collectDockerContainers({
    exec: async (file, args, options) => {
      assert.equal(file, 'docker')
      assert.deepEqual(args, ['ps', '-a', '--format', '{{json .}}'])
      assert.ok(options.timeout > 0)
      return { stdout }
    },
  })
  assert.deepEqual(containers, [
    { name: 'immich_server', state: 'running', status: 'Up 2 hours (healthy)', health: 'healthy' },
    { name: 'plex', state: 'exited', status: 'Exited (0) 3 minutes ago', health: null },
    { name: 'fresh', state: 'restarting', status: 'Restarting (1) 4 seconds ago (health: starting)', health: 'starting' },
  ])
  // Unhealthy containers and non-running states degrade exactly like the agent payload.
  assert.equal(publicDevice(device, { ...base, containers }).status, 'degraded')
})
