import express from 'express'
import si from 'systeminformation'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const root = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 4242)
const devicesPath = path.resolve(process.env.MISSION_CONTROL_DEVICES || path.join(root, 'devices.json'))

app.use(express.json())

async function linuxGpuUsage() {
  if (process.platform !== 'linux') return null
  try {
    const entries = await fs.readdir('/sys/class/drm')
    for (const entry of entries.filter((name) => /^card\d+$/.test(name))) {
      try {
        const raw = await fs.readFile(`/sys/class/drm/${entry}/device/gpu_busy_percent`, 'utf8')
        const value = Number(raw.trim())
        if (Number.isFinite(value)) return Math.round(value)
      } catch { /* This GPU/driver does not provide the metric. */ }
    }
  } catch { /* sysfs is unavailable (for example, inside some containers). */ }
  return null
}

async function localStats() {
  const [cpu, load, mem, disks, os, time, graphics, docker] = await Promise.all([
    si.cpu(), si.currentLoad(), si.mem(), si.fsSize(), si.osInfo(), Promise.resolve(si.time()),
    si.graphics().catch(() => ({ controllers: [] })),
    si.dockerContainers(true).catch(() => []),
  ])
  const disk = disks.find((item) => item.mount === '/') || disks[0]
  const gpu = graphics.controllers?.[0]
  const gpuLoad = Number.isFinite(gpu?.utilizationGpu) ? Math.round(gpu.utilizationGpu) : await linuxGpuUsage()
  return {
    online: true,
    os: `${os.distro} ${os.release}`,
    uptime: time.uptime,
    specs: {
      cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
      cores: `${cpu.physicalCores}C / ${cpu.cores}T`,
      memory: `${(mem.total / 1073741824).toFixed(0)} GB`,
      disk: disk ? `${(disk.size / 1073741824).toFixed(0)} GB` : '—',
      gpu: gpu?.model || 'Integrated / unavailable',
    },
    usage: {
      cpu: Math.round(load.currentLoad || 0),
      memory: Math.round((mem.active / mem.total) * 100),
      disk: Math.round(disk?.use || 0),
      gpu: gpuLoad,
      temperature: null,
    },
    containers: docker.map((c) => ({ name: c.name, state: c.state, status: c.status })),
    services: [],
  }
}

function demoStats(device, index) {
  const values = [[21, 44, 61], [34, 58, 47], [16, 37, 28]][index % 3]
  const server = device.type === 'server'
  return {
    online: true,
    demo: true,
    os: server ? 'Ubuntu Server 24.04' : 'Ubuntu 24.04 LTS',
    uptime: server ? 1450920 : 341880,
    specs: {
      cpu: server ? 'Intel Xeon E-2236' : 'Intel Core i7', cores: server ? '6C / 12T' : '8C / 16T',
      memory: server ? '32 GB' : '16 GB', disk: server ? '4 TB' : '1 TB', gpu: server ? 'Headless' : 'Intel Iris Xe',
    },
    usage: { cpu: values[0], memory: values[1], disk: values[2], gpu: server ? null : 23, temperature: server ? 42 : 48 },
    containers: (device.containers || []).map((name, i) => ({ name, state: i ? 'running' : 'running', status: `Up ${i ? '9 days' : '17 hours'}` })),
    services: [],
  }
}

async function getDevices() {
  return JSON.parse(await fs.readFile(devicesPath, 'utf8'))
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.get('/api/devices', async (_req, res) => {
  try {
    const devices = await getDevices()
    const results = await Promise.all(devices.map(async (device, index) => {
      try {
        let stats
        if (device.endpoint === 'local') stats = await localStats()
        else if (device.endpoint === 'demo') stats = demoStats(device, index)
        else {
          const response = await fetch(`${device.endpoint.replace(/\/$/, '')}/api/agent/stats`, {
            signal: AbortSignal.timeout(4000),
            headers: device.token ? { Authorization: `Bearer ${device.token}` } : {},
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          stats = await response.json()
        }
        return { ...device, ...stats }
      } catch (error) {
        return { ...device, online: false, error: error.message, usage: {}, specs: {} }
      }
    }))
    res.json({ devices: results, updatedAt: new Date().toISOString() })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/agent/stats', async (_req, res) => {
  try { res.json(await localStats()) } catch (error) { res.status(500).json({ error: error.message }) }
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
}

const server = app.listen(port, '0.0.0.0', () => console.log(`Mission Control API listening on http://0.0.0.0:${port}`))
server.on('error', (error) => {
  console.error(`Mission Control failed to start: ${error.message}`)
  process.exitCode = 1
})
