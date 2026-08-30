import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, Box, Cpu, Database, Gamepad2, Gauge, HardDrive, Laptop, MemoryStick, RefreshCw, Server, ShieldCheck, Thermometer, Wifi, WifiOff } from 'lucide-react'
import './styles.css'

const icons = { pc: Cpu, server: Server, laptop: Laptop }

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`
}

function Meter({ label, value, Icon }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  const tone = safe > 85 ? 'danger' : safe > 70 ? 'warn' : ''
  return <div className="meter">
    <div className="meter-top"><span><Icon size={15} />{label}</span><strong>{Number.isFinite(value) ? `${safe}%` : 'N/A'}</strong></div>
    <div className="track"><i className={tone} style={{ width: `${safe}%` }} /></div>
  </div>
}

function DeviceCard({ device, index }) {
  const Icon = icons[device.type] || Server
  const usage = device.usage || {}
  return <article className={`device-card accent-${device.accent || 'green'}`} style={{ '--delay': `${index * 70}ms` }}>
    <div className="card-head">
      <div className="device-icon"><Icon size={22} /></div>
      <div className="identity"><span>{device.label || 'SYSTEM NODE'}</span><h2>{device.name}</h2></div>
      <div className={`status ${device.online ? '' : 'offline'}`}>{device.online ? <Wifi size={14}/> : <WifiOff size={14}/>} {device.online ? 'ONLINE' : 'OFFLINE'}</div>
    </div>
    {device.demo && <div className="demo-tag">DEMO DATA · configure endpoint to connect</div>}
    <div className="system-line"><span>{device.os || 'System unavailable'}</span><span>UP {formatUptime(device.uptime)}</span></div>
    <div className="spec-grid">
      <div><small>PROCESSOR</small><b>{device.specs?.cpu || '—'}</b><em>{device.specs?.cores}</em></div>
      <div><small>MEMORY</small><b>{device.specs?.memory || '—'}</b></div>
      <div><small>STORAGE</small><b>{device.specs?.disk || '—'}</b></div>
      <div><small>GRAPHICS</small><b>{device.specs?.gpu || '—'}</b></div>
    </div>
    <div className="meters">
      <Meter label="CPU LOAD" value={usage.cpu} Icon={Cpu} />
      <Meter label="GPU LOAD" value={usage.gpu} Icon={Gauge} />
      <Meter label="MEMORY" value={usage.memory} Icon={MemoryStick} />
      <Meter label="STORAGE" value={usage.disk} Icon={HardDrive} />
      {Number.isFinite(usage.temperature) && <Meter label="THERMAL" value={usage.temperature} Icon={Thermometer} />}
    </div>
    {!!device.containers?.length && <div className="containers">
      <div className="section-title"><span><Box size={14}/> CONTAINERS</span><small>{device.containers.filter(c => c.state === 'running').length}/{device.containers.length} ACTIVE</small></div>
      {device.containers.map((container) => <div className="container-row" key={container.name}>
        <span className={`pulse ${container.state !== 'running' ? 'stopped' : ''}`} />
        <b>{container.name}</b><em>{container.status || container.state}</em>
      </div>)}
    </div>}
    {!!device.services?.length && <div className="containers services">
      <div className="section-title"><span><Gamepad2 size={14}/> SERVICES</span><small>{device.services.filter(s => s.state === 'active').length}/{device.services.length} ACTIVE</small></div>
      {device.services.map((service) => <div className="container-row" key={service.id}>
        <span className={`pulse ${service.state !== 'active' ? 'stopped' : ''}`} />
        <b>{service.name}</b><em>{service.state.toUpperCase()} · {service.detail}</em>
      </div>)}
    </div>}
  </article>
}

function App() {
  const [data, setData] = useState({ devices: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = async () => {
    try {
      const response = await fetch('/api/devices')
      if (!response.ok) throw new Error('Telemetry service unavailable')
      setData(await response.json()); setError('')
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { load(); const timer = setInterval(load, 10000); return () => clearInterval(timer) }, [])
  const online = data.devices.filter(d => d.online).length
  return <main>
    <header>
      <div className="brand"><div className="mark"><Activity size={23}/></div><div><span>SYS::OVERVIEW</span><h1>mission_control</h1></div></div>
      <div className="header-right">
        <div className="summary"><span><i /> NETWORK NOMINAL</span><b>{online}<small> / {data.devices.length} NODES</small></b></div>
        <button onClick={load} aria-label="Refresh telemetry"><RefreshCw size={18} className={loading ? 'spin' : ''}/></button>
      </div>
    </header>
    <div className="rule"><span>LIVE TELEMETRY</span><i /></div>
    {error && <div className="error">{error}</div>}
    {loading && !data.devices.length ? <div className="loading"><Activity/> Establishing telemetry link…</div> : <section className="device-grid">
      {data.devices.map((device, i) => <DeviceCard device={device} index={i} key={device.id}/>) }
    </section>}
    <footer><span><ShieldCheck size={14}/> SECURE LOCAL TELEMETRY</span><span>REFRESH 10S</span><span><Database size={14}/> {data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : 'WAITING'}</span></footer>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
