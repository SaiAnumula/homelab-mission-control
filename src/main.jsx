import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, Box, ChevronDown, Cpu, Database, Gamepad2, Gauge, HardDrive, Laptop, Layers, MemoryStick, RefreshCw, Server, ShieldCheck, Thermometer, Wifi, WifiOff } from 'lucide-react'
import './styles.css'
import { createPoller, deviceStatus } from './polling.js'

const icons = { pc: Cpu, server: Server, laptop: Laptop }

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`
}

function Meter({ label, value, Icon, unit = '%' }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  const tone = safe > 85 ? 'danger' : safe > 70 ? 'warn' : ''
  return <div className="meter">
    <div className="meter-top"><span><Icon size={15} />{label}</span><strong>{Number.isFinite(value) ? `${value}${unit}` : 'N/A'}</strong></div>
    <div className="track"><i className={tone} style={{ width: `${safe}%` }} /></div>
  </div>
}

function TooltipText({ children }) {
  if (!children) return '—'
  return <span className="tooltip-text" data-tooltip={children} tabIndex={0}>
    <span className="tooltip-value">{children}</span>
  </span>
}

function healthLabel(health) {
  return health === 'healthy' ? 'HEALTHY' : health === 'warning' ? 'WARNING' : health === 'failing' ? 'FAILING' : 'SMART N/A'
}

function DriveRow({ drive, primary = false }) {
  return <div className={`drive-row ${primary ? 'primary' : ''}`}>
    <div className="drive-name">
      <HardDrive size={14} />
      <span><b><TooltipText>{drive.model || drive.name || 'Storage device'}</TooltipText></b><small>{drive.mount || 'Not mounted'} · {drive.device}</small></span>
    </div>
    <strong>{drive.capacity || '—'}</strong>
    <em>{Number.isFinite(drive.usage) ? `${drive.usage}% USED` : 'USAGE N/A'}</em>
    <i className={`health ${drive.health || 'unavailable'}`}>{healthLabel(drive.health)}</i>
  </div>
}

function DriveDetails({ drives = [], fallback }) {
  const primary = drives.find(drive => drive.primary) || drives[0]
  if (!primary) return <div className="drive-panel"><div className="drive-label">STORAGE</div><b>{fallback || '—'}</b></div>
  const others = drives.filter(drive => drive !== primary)
  if (!others.length) return <div className="drive-panel"><div className="drive-label">STORAGE</div><DriveRow drive={primary} primary /></div>
  return <details className="drive-panel">
    <summary>
      <span className="drive-label">STORAGE · {drives.length} DRIVES</span>
      <DriveRow drive={primary} primary />
      <ChevronDown className="drive-chevron" size={16} />
    </summary>
    <div className="drive-list">{others.map(drive => <DriveRow drive={drive} key={drive.device || drive.name} />)}</div>
  </details>
}

function DeviceCard({ device, index, stale }) {
  const status = deviceStatus(device, stale)
  const Icon = icons[device.type] || Server
  const usage = device.usage || {}
  return <article className={`device-card accent-${device.accent || 'green'}`} style={{ '--delay': `${index * 70}ms` }}>
    <div className="card-head">
      <div className="device-icon"><Icon size={22} /></div>
      <div className="identity"><span>{device.label || 'SYSTEM NODE'}</span><h2>{device.name}</h2></div>
      <div className={`status ${status}`} aria-label={`Status: ${status}`}>{status === 'up' ? <Wifi size={14}/> : <WifiOff size={14}/>} {status.toUpperCase()}</div>
    </div>
    {device.demo && <div className="demo-tag">DEMO DATA · configure endpoint to connect</div>}
    <div className="system-line">
      <span>{device.online ? (device.os || 'System unavailable') : (device.error ? `OFFLINE · ${device.error}` : 'Host unreachable')}</span>
      <span>{device.online ? `UP ${formatUptime(device.uptime)}` : 'DISCONNECTED'}</span>
    </div>
    <div className="last-checked">Last checked: {Number.isFinite(Date.parse(device.checkedAt)) ? new Date(device.checkedAt).toLocaleTimeString() : 'Unknown'}{status === 'stale' && ' · Values may be outdated'}</div>
    <div className="spec-grid">
      <div><small>PROCESSOR</small><b><TooltipText>{device.specs?.cpu}</TooltipText></b><em>{device.specs?.cores}</em></div>
      <div><small>MEMORY</small><b>{device.specs?.memory || '—'}</b></div>
      <div>
        <small>GRAPHICS</small>
        <b><TooltipText>{device.specs?.gpu}</TooltipText></b>
        {device.specs?.vram && <em>VRAM {device.specs.vram}</em>}
      </div>
    </div>
    <DriveDetails drives={device.drives} fallback={device.specs?.disk} />
    <div className="meters">
      <Meter label="CPU LOAD" value={usage.cpu} Icon={Cpu} />
      <Meter label="GPU LOAD" value={usage.gpu} Icon={Gauge} />
      {Number.isFinite(usage.gpu_vram) && <Meter label="GPU VRAM" value={usage.gpu_vram} Icon={Layers} />}
      <Meter label="MEMORY" value={usage.memory} Icon={MemoryStick} />
      <Meter label="STORAGE" value={usage.disk} Icon={HardDrive} />
      {Number.isFinite(usage.temperature) && <Meter label="THERMAL" value={usage.temperature} Icon={Thermometer} unit="°C" />}
    </div>
    {(usage.net_rx_rate || usage.net_tx_rate || usage.disk_read_rate || usage.disk_write_rate) && (
      <div className="io-grid">
        <div className="io-item" title="Network Throughput">
          <small><Activity size={10} /> NETWORK</small>
          <span>↓ {usage.net_rx_rate || '0 B/s'} &nbsp; ↑ {usage.net_tx_rate || '0 B/s'}</span>
        </div>
        <div className="io-item" title="Disk Throughput">
          <small><HardDrive size={10} /> DISK I/O</small>
          <span>R: {usage.disk_read_rate || '0 B/s'} &nbsp; W: {usage.disk_write_rate || '0 B/s'}</span>
        </div>
      </div>
    )}
    {!!device.containers?.length && <div className="containers">
      <div className="section-title"><span><Box size={14}/> CONTAINERS</span><small>{device.containers.filter(c => c.state === 'running').length}/{device.containers.length} ACTIVE</small></div>
      {device.containers.map((container) => {
        const pulseClass = container.state !== 'running'
          ? 'stopped'
          : container.health === 'unhealthy'
          ? 'unhealthy'
          : container.health === 'starting'
          ? 'starting'
          : ''
        return <div className="container-row" key={container.name}>
          <span className={`pulse ${pulseClass}`} />
          <b><TooltipText>{container.name}</TooltipText></b>
          <em>{container.health ? `${container.health.toUpperCase()} · ` : ''}{container.status || container.state}</em>
        </div>
      })}
    </div>}
    {!!device.services?.length && <div className="containers services">
      <div className="section-title"><span><Gamepad2 size={14}/> SERVICES</span><small>{device.services.filter(s => s.state === 'active').length}/{device.services.length} ACTIVE</small></div>
      {device.services.map((service) => <div className="container-row" key={service.id}>
        <span className={`pulse ${service.state !== 'active' ? 'stopped' : ''}`} />
        <b><TooltipText>{service.name}</TooltipText></b><em>{service.state.toUpperCase()} · {service.detail}</em>
      </div>)}
    </div>}
  </article>
}

function App() {
  const [data, setData] = useState({ devices: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const poller = useRef(null)
  useEffect(() => {
    const active = createPoller({
      onData: next => { setData(next); setError('') },
      onError: setError,
      onLoading: setLoading,
    })
    poller.current = active
    active.refresh()
    return () => { active.stop(); poller.current = null }
  }, [])
  const stale = Boolean(error)
  const online = data.devices.filter(d => deviceStatus(d, stale) === 'up').length
  const summary = stale ? 'TELEMETRY STALE' : loading && !data.devices.length ? 'CONNECTING' : !data.devices.length ? 'NO NODES' : online === data.devices.length ? 'NETWORK UP' : 'NETWORK DEGRADED'
  return <main>
    <header>
      <div className="brand"><div className="mark"><Activity size={23}/></div><div><span>SYS::OVERVIEW</span><h1>mission_control</h1></div></div>
      <div className="header-right">
        <div className="summary"><span><i /> {summary}</span><b>{online}<small> / {data.devices.length} NODES</small></b></div>
        <button onClick={() => poller.current?.refresh()} disabled={loading} aria-label="Refresh telemetry" aria-busy={loading}><RefreshCw size={18} className={loading ? 'spin' : ''}/></button>
      </div>
    </header>
    <div className="rule"><span>{stale ? 'STALE TELEMETRY' : 'TELEMETRY'}</span><i /></div>
    {error && <div className="error" role="alert">{error}</div>}
    {loading && !data.devices.length ? <div className="loading"><Activity/> Establishing telemetry link…</div> : <section className="device-grid" aria-busy={loading}>
      {!loading && !error && !data.devices.length && <div className="loading">No devices configured. Add nodes to your local configuration.</div>}
      {data.devices.map((device, i) => <DeviceCard device={device} index={i} stale={stale} key={device.id}/>) }
    </section>}
    <footer><span><ShieldCheck size={14}/> SECURE LOCAL TELEMETRY</span><span>POLL 10S AFTER COMPLETION</span><span><Database size={14}/> {data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : 'WAITING'}</span></footer>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
