# Mission Control polish — 2026-10-11

All work is committed on `polish-oct11`. Nothing was pushed or merged.

## Changes

- Device configuration is validated rather than silently becoming an empty
  dashboard. Both backends cap configurations at 64 entries, reject duplicate
  identifiers and unsuitable endpoint URLs, and preserve trusted display identity.
- API results contain public fields only. Credentials/endpoints and arbitrary
  agent identity fields are excluded. Malformed/nested/non-finite telemetry is
  rejected; network and unexpected worker errors do not disclose private URLs.
  Python limits response bodies to one MiB.
- Python dashboard, Node API, and Python agent share ten-second caches across
  clients. Concurrent refreshes share collection, including failed endpoint
  checks, reducing pressure on monitored hosts. Python collections have worker
  caps. Service probes run concurrently, deduplicate names, and show unavailable
  checks as unknown instead of quietly omitting them.
- SMART command errors no longer imply healthy disks; real disk-failure flags
  remain failures. A known OS description avoids an unnecessary platform probe.
  Agent collection failures return JSON with HTTP 503, with briefly cached
  failures instead of retaining an old online response.
- Browser polling waits ten seconds after completion, limits a request to six
  seconds, coalesces manual refresh, and aborts on unmount. Cards show UP, DOWN,
  DEGRADED, or STALE with last-checked timestamps; collection timestamps inform
  snapshot age. Errors retain the last snapshot with honest stale labels, and
  loading/empty states offer guidance.
- CI caches npm downloads and runs mocked Node tests, strict ESLint warnings,
  TypeScript checks of frontend and Node JavaScript, Python syntax compilation,
  Python tests with warnings treated as errors, and the production Vite build.
  New packages are development-only ESLint, TypeScript, and type definitions;
  their purpose is justified in the CI commits. Runtime dependencies are unchanged.
- README now describes reproducible setup, Node requirements, tests, cache and
  timeout behavior, and limitations. Default Node configuration uses synthetic
  demo data; production examples use reserved `.example` names.
- Python tests now fail closed on sockets, DNS, bind operations, and subprocesses,
  including targeted module runs. API and service tests use mocked fixtures.

## Verification

Environment: Node 26.10.0, npm 12.2.0, Python 3.14.7. CI targets Node 22 and
Python 3.12; those exact versions were not separately exercised locally.

| Check | Actual result |
| --- | --- |
| `npm ci` | Passed; lockfile installs reproducibly |
| `npm test` | Passed: 56 Python tests and 11 Node tests |
| `python3 -W error -m unittest discover -s tests` | Passed: 56 tests |
| `npm run lint` | Passed; zero warnings permitted |
| `npm run typecheck` | Passed; frontend and Node JavaScript checked |
| `npm run build` | Passed; Vite 8.2.2 production assets generated |
| `python3 -W error -m compileall -q agent deploy tests` | Passed |
| `git diff --check` | Passed |
| Production example configuration validation | Passed without contacting endpoints |

The original baseline passed 30 Python tests and the Vite build. That baseline
included isolated ephemeral loopback HTTP fixture servers; all socket fixtures
were subsequently replaced with mocks, and every subsequent full Python run
used guards. No real homelab endpoint or service was contacted, restarted, or
modified; no SSH or live Docker operation ran.

Node's built-in coverage report for the tested helper modules records 100% line
coverage for `src/polling.js`, 98.31% for `telemetry.js`, and 88.24% combined branch
coverage. This excludes React rendering and executable server/platform collectors.
Python regression coverage increased from 30 to 56 tests; no Python percentage
is claimed. A new fully mocked stats test initially exposed the unnecessary
platform subprocess; the final suite passes after fixing it.

No required test, lint, typecheck, or build check remains failing. `npm audit`
reported four dependency advisories (one high and three critical), involving
source-map-js, concurrently/shell-quote, and proxy-addr. These were recorded,
not automatically force-upgraded.

## Deliberately skipped

- No deployment, live monitoring validation, server connection, or service change.
- No authentication, network policy, or secret-management redesign.
- No forced dependency upgrades or broad backend consolidation.
- No browser DOM automation or live Node/Python hardware collector checks.
- No third-party Python linter/typechecker or runtime dependency; Python syntax,
  warnings, and regression tests run, while ESLint covers JavaScript.
- Agent subprocesses have individual deadlines, but the first full collection
  has no absolute global deadline. Slow GPU discovery or large disk/service
  inventories can still exceed the dashboard's four-second socket timeout.
  Caching prevents repeated work but does not guarantee first-sample latency.
- Node remote collection remains concurrent across the validated device list
  (maximum 64), rather than using Python's eight-worker pool.

## Next five worthwhile improvements

1. Add an absolute collection budget and independently refreshed cached hardware
   inventory, preserving partial metrics and explicit unavailable checks.
2. Evaluate and update the four vulnerable dependency paths with compatibility
   tests and an intentional lockfile update.
3. Add a bounded Node remote-worker pool and randomized/backoff refresh timing
   for installations with many clients and agents.
4. Add browser accessibility and rendered-state tests using synthetic responses,
   including stale/degraded transitions and keyboard interactions.
5. Unify shared schema/status semantics across the two backends and add mocked
   platform-collector coverage plus a Python coverage/static-analysis baseline.
