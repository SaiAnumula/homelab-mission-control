# Mission Control audit and roadmap

## Earlier observations

The October 14 audit recorded these observations on the deployed homelab:

- The Main PC and Home Server returned telemetry. The Vivobook was unreachable.
- The Home Server's `nvidia-smi` reported a driver and NVML library mismatch.
  Loading the matching kernel driver, usually through a planned reboot, should
  restore GPU telemetry. This was not rechecked or changed during the October 15
  connection investigation.
- The Main PC's root disk was 87% used at the time. This is a dated reading,
  rather than a current capacity measurement.

Private endpoints belong in the ignored runtime configuration. The repository's
example configurations use reserved documentation hostnames.

## October 15 connection investigation

The dashboard opened at 11:54:05 AM Eastern. The PC's Tailscale log selected a
direct path to the Home Server at 11:54:06. The first dashboard API request
finished at 11:54:10, while the PC's telemetry collection followed at 11:54:12.
The PC agent had no service restarts. A later check from the Home Server took
0.17 seconds for health and 0.54 seconds for telemetry.

The timing suggests that the first connection exceeded the dashboard's
four-second timeout. Individual endpoint failures were not logged, so the exact
failure could not be confirmed. The previous server marked one failed request
DOWN and cached the result for ten seconds, extending the visible interruption.

The connection-recovery change keeps old readings marked STALE, retries health
checks every second, marks DOWN after ten seconds of failed connectivity checks,
and checks DOWN devices every fifteen seconds. Background workers share checks
across browser clients. The README describes the current behavior and limits.

## Possible later work

These proposals are not implemented by the connection-recovery change:

- Add alerts for sustained outages, low disk space, failed services, and failing
  SMART checks. Notifications need deduplication and recovery notices.
- Store metric history and uptime summaries, with a retention policy.
- Add authenticated container or service controls only if remote control is
  needed. Monitoring currently reads system state without controlling services.
- Explore optional Tailscale discovery rather than requiring manual endpoints.
- Cache slow hardware inventory separately from frequently sampled metrics and
  give collection an overall deadline.
- Evaluate connection reuse and response compression if measurements justify
  them. Refresh on tab focus is included; polling still runs in hidden tabs,
  subject to browser timer throttling.
