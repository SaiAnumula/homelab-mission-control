# Mission Control polish, 2026-10-11

This records the October 11 polish work and how it was checked at the time. The
work was later merged into `main` together with the October 15
connection-recovery change. The cache and polling behavior below is the October
11 version. The README describes current behavior.

## Changes

- The backends validate the device configuration instead of quietly showing an
  empty dashboard. Both cap a configuration at 64 entries, reject duplicate
  identifiers and unsuitable endpoint URLs, and keep the configured display
  identity.
- API results contain only public fields. They leave out credentials, endpoints,
  and any identity fields an agent sends. The backends reject malformed, nested,
  or non-finite telemetry. Network errors and unexpected worker errors don't
  reveal private URLs. Python limits response bodies to 1 MiB.
- The Python dashboard, the Node API, and the Python agent each share a
  ten-second cache across clients. Concurrent refreshes share one collection,
  including failed endpoint checks, which reduces load on monitored hosts.
  Python collections have worker caps. Service probes run concurrently, skip
  duplicate names, and show a check that couldn't run as unknown instead of
  leaving it out.
- A SMART command error no longer reads as a healthy disk. Real disk-failure
  flags still count as failures. When the OS description is already known, the
  agent skips a platform probe it doesn't need. When agent collection fails, the
  agent returns JSON with HTTP 503 and caches the failure briefly, instead of
  keeping an old online response.
- The browser waits ten seconds after a request finishes before the next poll,
  gives each request six seconds, merges manual refreshes into the running
  request, and aborts on unmount. Cards show UP, DOWN, DEGRADED, or STALE with
  last-checked times, and collection timestamps feed into snapshot age. After an
  error the last snapshot stays on screen with STALE labels. The loading and
  empty states explain what to do.
- CI caches npm downloads. It runs the mocked Node tests, ESLint with warnings
  as failures, TypeScript checks of the frontend and Node JavaScript, Python
  syntax compilation, Python tests with warnings as errors, and the production
  Vite build. The new packages are ESLint, TypeScript, and type definitions, all
  development-only. The CI commits explain why each was added. Runtime
  dependencies didn't change.
- The README now covers reproducible setup, Node requirements, tests, cache and
  timeout behavior, and limitations. The default Node configuration uses
  synthetic demo data. Production examples use reserved `.example` names.
- The Python tests now fail on any socket, DNS, bind, or subprocess call, even
  when a single module runs. API and service tests use mocked fixtures.

## Verification

Environment: Node 26.10.0, npm 12.2.0, Python 3.14.7. CI targets Node 22 and
Python 3.12. Those exact versions weren't run locally.

| Check | Result |
| --- | --- |
| `npm ci` | Passed. The lockfile installs reproducibly. |
| `npm test` | Passed: 56 Python tests and 11 Node tests |
| `python3 -W error -m unittest discover -s tests` | Passed: 56 tests |
| `npm run lint` | Passed with zero warnings allowed |
| `npm run typecheck` | Passed. Frontend and Node JavaScript checked. |
| `npm run build` | Passed. Vite 8.2.2 built the production assets. |
| `python3 -W error -m compileall -q agent deploy tests` | Passed |
| `git diff --check` | Passed |
| Production example configuration validation | Passed without contacting endpoints |

Before this work, 30 Python tests and the Vite build passed. That baseline used
isolated loopback HTTP servers as fixtures. Mocks later replaced every socket
fixture, and every full Python run after that had the guards on. Nothing
contacted, restarted, or changed a real homelab endpoint or service, and no SSH
or live Docker command ran.

Node's built-in coverage report for the tested helper modules showed 100% line
coverage for `src/polling.js`, 98.31% for `telemetry.js`, and 88.24% branch
coverage across both. That excludes React rendering and the server and platform
collectors. Python went from 30 to 56 tests. No Python coverage percentage was
measured. A new fully mocked stats test caught the unneeded platform subprocess,
and the final suite passes with that fixed.

Every required test, lint, typecheck, and build check passed. `npm audit`
reported four dependency advisories, one high and three critical, in
source-map-js, concurrently/shell-quote, and proxy-addr. They were recorded and
not force-upgraded.

## Deliberately skipped

- No deployment, live monitoring check, server connection, or service change.
- No redesign of authentication, network policy, or secret management.
- No forced dependency upgrades and no broad merge of the two backends.
- No browser DOM automation, and no live run of the Node or Python hardware
  collectors.
- No third-party Python linter, typechecker, or runtime dependency. Python
  syntax, warnings, and regression tests run, and ESLint covers JavaScript.
- Each agent subprocess has its own deadline, but the first full collection has
  no overall deadline. Slow GPU discovery or a large disk or service inventory
  can still exceed the dashboard's four-second socket timeout. Caching prevents
  repeated work but doesn't bound the latency of the first sample.
- Node collected from every device in the validated list at once, up to 64,
  instead of using an eight-worker pool like Python.

## Next five worthwhile improvements

1. Give collection an overall time budget, and cache hardware inventory
   separately on its own refresh, while keeping partial metrics and marking
   checks that couldn't run.
2. Update the four vulnerable dependency paths with an intentional lockfile
   update and compatibility tests.
3. Add a bounded worker pool for Node remote collection, and randomized or
   backoff refresh timing for installations with many clients and agents.
4. Add browser tests for accessibility and rendered states using synthetic
   responses, including stale and degraded transitions and keyboard use.
5. Share one schema and set of status rules between the two backends, add mocked
   platform-collector tests, and set a baseline for Python coverage and static
   analysis.
