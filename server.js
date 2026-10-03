import express from 'express'
import si from 'systeminformation'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const root = path.dirname(fileURLToPath(import.meta.url))
const host = process.env.MISSION_CONTROL_HOST || process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 4242)
const devicesPath = path.resolve(process.env.MISSION_CONTROL_DEVICES || path.join(root, 'devices.json'))

app.use(express.json())

function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  if (bytesPerSec >= 1e9) return `${(bytesPerSec / 1e9).toFixed(1)} GB/s`
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`
  return `${Math.round(bytesPerSec)} B/s`
}

async function linuxGpuUsage() {
  if (process.platform !== 'linux') return null
  try {
    const entries = await fs.readdir('/sys/class/drm')
    for (const entry of entries.filter((name) => /^card\d+$/.test(name))) {
      try {
        const raw = await fs.readFile(`/sys/class/drm/${entry}/device/gpu_busy_percent`, 'utf8')
        const value = Number(raw.trim())
        if (Number.isFinite(value)) return Math.round(value)
      } catch (err) {
        if (err.code === 'EBUSY') return 0
      }
    }
  } catch { /* sysfs is unavailable (for example, inside some containers). */ }
  return null
}

async function localStats() {
  const [cpu, load, mem, disks, os, time, graphics, docker, temp, net, fsStats] = await Promise.all([
    si.cpu(), si.currentLoad(), si.mem(), si.fsSize(), si.osInfo(), Promise.resolve(si.time()),
    si.graphics().catch(() => ({ controllers: [] })),
    si.dockerContainers(true).catch(() => []),
    si.cpuTemperature().catch(() => ({})),
    si.networkStats().catch(() => []),
    si.fsStats().catch(() => ({})),
  ])
  const disk = disks.find((item) => item.mount === '/') || disks[0]
  const gpu = graphics.controllers?.[0]
  const gpuLoad = Number.isFinite(gpu?.utilizationGpu) ? Math.round(gpu.utilizationGpu) : await linuxGpuUsage()
  const vramMb = gpu?.vram || gpu?.memoryTotal
  const vramLabel = vramMb ? `${(vramMb / 1024).toFixed(0)} GB` : null
  const activeNet = net.find((item) => !item.iface?.startsWith('lo')) || net[0]
  const drives = disks
    .filter((d) => d.size > 0 && !d.mount?.startsWith('/dev') && !d.fs?.startsWith('efivarfs'))
    .map((d) => ({
      name: path.basename(d.fs || d.mount),
      device: d.fs,
      model: '',
      capacity: d.size >= 1e12 ? `${(d.size / 1e12).toFixed(1)} TB` : `${(d.size / 1e9).toFixed(0)} GB`,
      size_bytes: d.size,
      mount: d.mount,
      used_bytes: d.used,
      usage: Math.round(d.use || 0),
      health: 'unavailable',
      primary: d.mount === '/',
    }))

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
      vram: vramLabel,
    },
    usage: {
      cpu: Math.round(load.currentLoad || 0),
      memory: Math.round(((mem.total - (mem.available || mem.free || 0)) / mem.total) * 100),
      disk: Math.round(disk?.use || 0),
      gpu: gpuLoad,
      gpu_vram: null,
      temperature: Math.round(temp.main || temp.max || 0) || null,
      net_rx_rate: formatRate(activeNet?.rx_sec),
      net_tx_rate: formatRate(activeNet?.tx_sec),
      disk_read_rate: formatRate(fsStats?.rx_sec),
      disk_write_rate: formatRate(fsStats?.wx_sec),
    },
    drives,
    containers: docker.map((c) => {
      let health = null
      if (c.status?.includes('(healthy)')) health = 'healthy'
      else if (c.status?.includes('(unhealthy)')) health = 'unhealthy'
      else if (c.status?.includes('(health: starting)')) health = 'starting'
      return { name: c.name, state: c.state, status: c.status, health }
    }),
    services: [],
  }
}

function demoStats(device, index) {
  const values = [[21, 44, 61], [34, 58, 47], [16, 37, 28]][index % 3]
  const server = device.type === 'server'
  const drives = [
    { name: 'nvme0n1', device: '/dev/nvme0n1', model: 'Samsung 980 Pro', capacity: server ? '2 TB' : '1 TB', size_bytes: server ? 2e12 : 1e12, mount: '/', used_bytes: null, usage: values[2], health: 'healthy', primary: true },
    ...(server ? [{ name: 'sda', device: '/dev/sda', model: 'Seagate IronWolf', capacity: '4 TB', size_bytes: 4e12, mount: '/mnt/storage', used_bytes: null, usage: 38, health: 'healthy', primary: false }] : [])
  ]
  return {
    online: true,
    demo: true,
    os: server ? 'Ubuntu Server 24.04' : 'Ubuntu 24.04 LTS',
    uptime: server ? 1450920 : 341880,
    specs: {
      cpu: server ? 'Intel Xeon E-2236' : 'Intel Core i7', cores: server ? '6C / 12T' : '8C / 16T',
      memory: server ? '32 GB' : '16 GB', disk: server ? '2 TB' : '1 TB', gpu: server ? 'Headless' : 'Intel Iris Xe',
      vram: server ? null : '1.2 / 8 GB',
    },
    usage: {
      cpu: values[0], memory: values[1], disk: values[2], gpu: server ? null : 23,
      gpu_vram: server ? null : 15,
      temperature: server ? 42 : 48,
      net_rx_rate: server ? '4.8 MB/s' : '850 KB/s',
      net_tx_rate: server ? '2.1 MB/s' : '120 KB/s',
      disk_read_rate: server ? '12 MB/s' : '0 B/s',
      disk_write_rate: server ? '34 MB/s' : '45 KB/s',
    },
    drives,
    containers: (device.containers || []).map((name, i) => ({
      name,
      state: 'running',
      status: `Up ${i ? '9 days' : '17 hours'} (healthy)`,
      health: 'healthy',
    })),
    services: [],
  }
}

async function getDevices() {
  try {
    return JSON.parse(await fs.readFile(devicesPath, 'utf8'))
  } catch {
    return []
  }
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

const server = app.listen(port, host, () => console.log(`Mission Control API listening on http://${host}:${port}`))
server.on('error', (error) => {
  console.error(`Mission Control failed to start: ${error.message}`)
  process.exitCode = 1
})
