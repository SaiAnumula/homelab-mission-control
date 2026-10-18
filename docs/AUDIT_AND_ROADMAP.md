# Mission Control audit and roadmap

## Earlier observations

The October 14 audit of the deployed homelab recorded the following:

- The Main PC and the Home Server returned telemetry. The Vivobook was unreachable.
- On the Home Server, `nvidia-smi` reported a mismatch between the driver and
  the NVML library. Loading the matching kernel driver, usually with a planned
  reboot, should restore GPU telemetry. Nobody rechecked or changed this during
  the October 15 connection investigation.
- The Main PC's root disk was 87% full on October 14. Treat this as a dated
  reading, not current capacity.

Private endpoints belong in the ignored runtime configuration. The example
configurations in the repository use reserved documentation hostnames.

## October 15 connection investigation

The dashboard opened at 11:54:05 AM Eastern. At 11:54:06, the PC's Tailscale
log chose a direct path to the Home Server. The first dashboard API request
finished at 11:54:10, and the PC's telemetry collection followed at 11:54:12.
The PC agent had not restarted. A later check from the Home Server took 0.17
seconds for health and 0.54 seconds for telemetry.

The timing suggests the first connection took longer than the dashboard's
four-second timeout. The server didn't log individual endpoint failures, so we
couldn't confirm the exact failure. The old server marked a device DOWN after
one failed request and cached that result for ten seconds, which made the
visible outage longer.

After the connection-recovery change, the server keeps old readings and marks
them STALE. It retries health checks every second, marks a device DOWN after ten
seconds of failed connectivity checks, and checks DOWN devices every fifteen
seconds. Background workers share checks across browser clients. The README
describes the current behavior and limits.

## Possible later work

The connection-recovery change doesn't implement any of these:

- Alerts for sustained outages, low disk space, failed services, and failing
  SMART checks. Notifications need deduplication and recovery notices.
- Metric history and uptime summaries, with a retention policy.
- Authenticated container or service controls, only if remote control becomes
  necessary. Monitoring reads system state and controls nothing.
- Optional Tailscale discovery, so endpoints don't have to be listed by hand.
- A separate cache for slow hardware inventory, refreshed less often than
  fast-changing metrics, and an overall deadline for collection.
- Connection reuse and response compression, if measurements show they help.
  The dashboard refreshes when its tab regains focus. Hidden tabs still poll,
  subject to the browser's timer throttling.
