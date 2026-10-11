# Mission Control audit — 2026-10-11

Read-only source review on `polish-oct11`, before implementation. No runtime
configuration was opened and no monitored endpoint or service was contacted.

## Ranked findings

1. **High: refresh amplification and stale health.** Every Python API request
   launches a fresh pool of up to eight remote probes. Multiple dashboards or
   overlapping browser refreshes multiply probes. The React ten-second interval
   can overlap a slow request; failures retain old cards marked ONLINE and the
   heading always says NETWORK NOMINAL. There is no request deadline in React.
2. **High: unchecked configuration and telemetry.** Python silently treats
   missing, malformed, or non-array config as zero devices. Arrays containing
   non-object entries can crash workers. Duplicate identifiers confuse React.
   Agent JSON may be a non-object and can overwrite trusted identity fields.
   Both backends return private configuration fields, including any token.
3. **High: telemetry collection can exceed the dashboard deadline.** Individual
   SMART commands allow four seconds, GPU discovery can take several sequential
   three-second calls, services take three seconds each, and the agent recomputes
   all data for every request. Collector exceptions can close an HTTP connection
   without a useful JSON error. Service timeout/failure is silently omitted,
   indistinguishable from an unconfigured service.
4. **Medium: sparse API/error coverage.** Existing Python tests cover formatting,
   some storage probes, concurrency, and health routes, but little malformed
   agent/config handling, service failure, cache behavior, or API failure status.
   Some tests create loopback sockets instead of mocking network transport.
5. **Medium: CI misses static checks.** CI only runs unittest and Vite build;
   Node cache is absent and neither lint nor typechecking runs. Python remains
   standard-library only; tooling should remain development-only.
6. **Medium: misleading setup and examples.** README lacks test instructions,
   advertises Node 20 despite Vite 8, and examples start local hardware collection
   or use plausible private-network addresses. A safe demo mode should be clear.
7. **Low: rough loading/empty UX and confusing dual backends.** Manual refresh
   never re-enables loading, empty config has no guidance, last update exists only
   in the footer, and Node and Python have divergent telemetry semantics.
   Most UI code lives in one JSX file; avoid broad restructuring in this pass.

## Existing safeguards and limits

- Python dashboard probes have a four-second socket timeout and eight-worker cap;
  failures normally produce an offline card and preserve config order.
- SMART probes have an eight-worker cap and subprocess timeouts. Docker and
  systemd commands are observational, but tests must mock them entirely.
- Runtime configs and environment files are ignored by Git. Templates should use
  reserved `.example` names and synthetic data exclusively.
- There is no authentication. Bind/deployment/security changes are outside this
  pass, which operates only on source, mocks, and fixtures.

## Planned order

Replace socket tests with mocks and enforce test isolation; validate configuration
and agent payloads; retain trusted public identity; share a short cache across
browser requests; expose honest timestamps and degraded status; cover service
errors and agent API failures; improve polling UX, CI, and setup documentation.
Record checks and deliberately deferred operational changes in SUMMARY.md.
