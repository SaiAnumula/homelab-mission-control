# Mission Control audit, 2026-10-11

This is a read-only source review of the `polish-oct11` branch, done before any
implementation. The review opened no runtime configuration and contacted no
monitored endpoint or service.

## Ranked findings

1. **High: refresh amplification and stale health.** Every Python API request
   started a new pool of up to eight remote probes. Several dashboards, or
   overlapping browser refreshes, multiplied the probes. The React ten-second
   interval could overlap a slow request. After a failure, old cards still said
   ONLINE and the heading always said NETWORK NOMINAL. React had no request
   deadline.
2. **High: unchecked configuration and telemetry.** Python treated a missing,
   malformed, or non-array configuration as zero devices without any error. An
   array with non-object entries could crash workers. Duplicate identifiers
   confused React. Agent JSON could be a non-object and could overwrite trusted
   identity fields. Both backends returned private configuration fields,
   including any token.
3. **High: telemetry collection could exceed the dashboard deadline.** Each
   SMART command allowed four seconds, GPU discovery could make several
   three-second calls in sequence, each service check allowed three seconds, and
   the agent recomputed everything on every request. A collector exception could
   close the HTTP connection without a useful JSON error. A service check that
   timed out or failed disappeared from the output, so it looked the same as a
   service that was never configured.
4. **Medium: thin coverage of the API and error paths.** The Python tests
   covered formatting, some storage probes, concurrency, and health routes. They
   barely covered malformed agent or configuration data, service failures, cache
   behavior, or API failure status. Some tests opened loopback sockets instead of
   mocking the network.
5. **Medium: CI skipped static checks.** CI ran only unittest and the Vite
   build. It had no Node cache and ran neither lint nor typechecking. Python
   should stay standard-library only, with any tooling limited to development.
6. **Medium: misleading setup and examples.** The README had no test
   instructions and listed Node 20, which Vite 8 doesn't support. The examples
   started local hardware collection or used realistic private-network
   addresses. The project needed a clearly documented safe demo mode.
7. **Low: rough loading and empty states, and two confusing backends.** Manual
   refresh never re-enabled loading, an empty configuration gave no guidance,
   and the last update time appeared only in the footer. The Node and Python
   backends reported telemetry differently. Most UI code lived in one JSX file,
   and this pass was to avoid restructuring it.

## Existing safeguards and limits

- Python dashboard probes had a four-second socket timeout and an eight-worker
  cap. A failure normally produced an offline card, and the configured order
  was kept.
- SMART probes had an eight-worker cap and subprocess timeouts. Docker and
  systemd commands only read state, but the tests still had to mock them fully.
- Git ignored runtime configurations and environment files. Templates were to
  use reserved `.example` names and synthetic data only.
- There was no authentication. Changes to binding, deployment, or security were
  out of scope. This pass touched only source, mocks, and fixtures.

## Planned order

1. Replace socket tests with mocks and enforce test isolation.
2. Validate configuration and agent payloads.
3. Keep the trusted public identity of each device.
4. Share a short cache across browser requests.
5. Report accurate timestamps and a degraded status.
6. Cover service errors and agent API failures.
7. Improve the polling UX, CI, and setup documentation.

Record the checks, and any operational changes deliberately left out, in
SUMMARY.md.
