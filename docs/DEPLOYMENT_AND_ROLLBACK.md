# Deployment and rollback

This is an update procedure for an existing installation, using the file-copy
deployment described in the README. Initial service installation is separate.
Run commands as the existing service owner. Keep host addresses, private device
configuration, recovery archives, and inspection reports out of Git.

## Approval and scope

Before merging, pushing, writing a release marker, copying application files, or
restarting a service, obtain approval for the exact revision and target scope.
Do not change sudoers, credentials, network bindings, device configuration,
systemd units, or unrelated services as part of an application update.

The dashboard and each agent are separate deployment targets. A dashboard update
does not authorize updating every configured agent. An inaccessible monitored
machine must remain unchanged; report its existing health limitations.

## Inspect the live installation

1. Inspect `systemctl --user cat` and `systemctl --user show` for the selected
   Mission Control units. Record active state, PID, restart count, command,
   environment, working directory, unit path, and any drop-ins. Confirm the
   configured service owner and existing SSH host identity without disabling
   host-key checking or changing access policy.
2. Derive application directories and ports from those units, rather than
   assuming the example defaults. The supported layout is
   `~/.local/share/mission-control-dashboard/{dashboard_server.py,dist,devices.json}`
   and `~/.local/share/mission-control/telemetry_agent.py`. An external device
   configuration selected by `MISSION_CONTROL_DEVICES` must also be inventoried
   and protected.
3. Hash the actual Python files and all frontend files. Compare them with the
   candidate source and a fresh `npm run check` build. Fetch the running HTML
   and referenced assets over HTTP and compare their hashes too. A
   `DEPLOYED_REVISION` marker is only a claim; it cannot override file evidence.
   Record a mixed or stale marker explicitly. For Python processes, compare
   file modification times with `ExecMainStartTimestamp` at microsecond
   precision (`systemctl --user --timestamp=us show`). If a source file was
   replaced after process startup, matching disk hashes cannot establish the
   loaded revision; stop before a marker-only reconciliation.
4. Record `/api/health`, `/api/devices`, and each selected agent's
   `/api/health` and `/api/agent/stats`. Preserve a baseline of device identity,
   freshness, drive health, services, and containers. Existing degraded states
   must be distinguished from new deployment regressions.
5. Confirm Python compatibility, free space, owner write access, enabled units,
   the user service manager, and recovery tools (`python3`, `tar`, `sha256sum`).
   Inspect the source diff for migrations or persistent state before applying
   this procedure. The current application has no database migration.

## SMART permissions

The updated agent resolves `smartctl` with `shutil.which` and invokes:

```text
<resolved-smartctl> -n standby,3 -H -j <physical-device-path>
```

When `MISSION_CONTROL_SMARTCTL_SUDO` is enabled, it prefixes that command with
`sudo -n`. Resolve the binary under the actual service environment, including
any group wrapper. Compare the exact binary, arguments, and per-device paths
against `sudo -n -l`. Do not add wildcards, general smartctl access, or a shell.

For each physical disk on the selected target, check the exact command with
`sudo -n -l -- <resolved-smartctl> -n standby,3 -H -j <device>`, then execute
the same read-only query with `sudo -n --` as the service owner. Inspect both
the exit status and JSON health result. Exit 3 means standby was skipped, not
a successful fresh health query. An inability to read SMART is not proof that a
disk is healthy. Never replace this with a wake-up probe or a write/self-test.

If the current allowlist already matches, keep it unchanged. Otherwise stop
and request separate approval for an exact per-device rule change; do not fall
back to broader privileges or an older command that wakes sleeping disks.

## Recovery snapshot and readiness gate

Before deployment, create a private, uniquely named recovery directory outside
the application trees, for example
`~/.local/state/mission-control-recovery/<UTC-timestamp>/`, with mode 0700.
Use umask 077. Capture the selected application directories, existing unit files
and drop-ins, any external configuration, and the existing revision marker.
Do not place archives in a web-served directory. Keep prior backups intact.

Record a manifest of file hashes and modes, service state, the approved candidate
SHA, and the archive SHA-256. Refuse unexpected symlinks or paths instead of
following them into other data. Check free space for the archive, staging tree,
and retained failed release. Recheck source hashes after archiving so a changing
source cannot silently become the recovery baseline.

Verify the archive checksum, extract it into a new private temporary directory
with Python tarfile's `filter='data'`, and compare every captured regular file's
hash and mode with the manifest. This verifies recoverable bytes without
restoring over live paths or restarting any service. Check configuration and
unit hashes again immediately before deployment; stop if they have drifted.
Refresh the snapshot if the live application files have changed since capture.

Keep the verified snapshot until the update is accepted. A backup name or an
old `dist.pre-*` directory alone is not evidence of recovery readiness.

## Integrate and update after final approval

1. Fetch origin and require a clean integration tree. Verify that the reviewed
   feature SHA and `origin/main` are unchanged. Use the repository's normal
   non-rewriting integration workflow. If main is an ancestor of the feature,
   a fast-forward is sufficient; otherwise inspect the merge result and stop
   on unexpected changes. Never force-push.
2. Run the complete `npm run check` suite on the integrated result and inspect
   the diff. Push the verified result to `origin/main` only within the approved
   scope, then confirm the actual remote SHA. If origin moves, re-evaluate the
   integrated result rather than overwriting it.
3. Compare the approved build and source hashes with the live files again.
   If all deployed application bytes already match, keep them and the running
   services in place. Reconcile only the stale `DEPLOYED_REVISION` marker after
   the live HTTP and source checks pass, using a temporary sibling and atomic
   rename. The marker must contain the integrated commit SHA, not a guessed
   historical deployment revision.
4. If application bytes differ, stage only approved application files outside
   the served tree. Verify their hashes, Python syntax, and referenced frontend
   assets before switching. Preserve live `devices.json`, external configuration,
   unit files, secrets, and other application data. Retain the previous `dist`
   tree under a unique recovery name and move the verified new tree into place;
   do not overlay old and new assets. Replace only changed Python files with
   verified staged copies. Restart only the Mission Control unit whose loaded
   Python code changed. Unit installation, daemon reload, enabling services,
   and linger changes are not part of this update.
5. Verify the actual service states and restart counts, HTTP health, HTML and
   asset hashes, fresh telemetry over multiple collection intervals, configured
   device identities, container/service visibility, and drive health against
   the baseline. Inspect recent logs for new errors. Do not call a build or a
   stale revision marker successful deployment evidence. Update the revision
   marker only after these checks pass.

## Roll back only if verification fails

1. Stop further updates. Confirm the exact host, service owner, affected unit,
   and recovery snapshot. Verify its checksum and extract into a fresh private
   staging directory. Compare recovered file hashes and modes with the manifest.
   Confirm configuration and units still match their pre-update hashes. If they
   changed independently, stop instead of restoring over another operator's work.
2. For a marker-only reconciliation, restore only the captured marker bytes
   using a temporary sibling and atomic rename; if it was previously absent,
   move the new marker into the recovery directory. No restart is required.
3. For changed application files, move the failed `dist` tree to a unique
   retained recovery path, then move the verified recovered `dist` into its old
   location. Restore only the Python files changed by this deployment, preserving
   their recorded modes. Restore the old marker or its prior absence. Keep
   current configuration, secrets, units, and data intact; do not extract the
   whole archive directly over the home directory or live application trees.
4. Restart only affected Mission Control units whose Python files were restored.
   Verify active state, old file/HTTP hashes, health, and telemetry against the
   pre-update baseline. Retain the failed release and logs for diagnosis. Report
   whether recovery succeeded, including any pre-existing degraded devices.

Do not test this procedure by performing a live rollback. If backup validation,
safe ownership, target access, or configuration preservation cannot be established,
stop before deployment.
