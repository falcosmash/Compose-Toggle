# Compose-Toggle
**Compose-Toggle** is a lightweight GNOME Shell extension that provides a simple way to start and stop a single Docker Compose stack directly from the top panel. It is designed with a security-first approach: unlike many Docker desktop integrations, it does **not** require adding users to the `docker` group, does **not** run privileged background services, and does **not** continuously monitor the Docker daemon. Every privileged operation is explicitly initiated by the user, keeping the trusted computing base as small as possible while making common `docker compose up` and `docker compose down` workflows convenient.
A GNOME Shell (45–50) panel extension to bring a Docker Compose stack up or
down from the top bar, with a strict security model: no docker group
membership, no background monitoring, no automatic privilege elevation.

## How it works

- A single root-owned helper script, `/usr/libexec/compose-ctl/compose-ctl`,
  runs `docker compose up -d` / `down` as root through `pkexec`.
- Every elevation corresponds to an explicit user gesture (flipping the
  toggle, registering the compose file, running the diagnostic). You get the
  standard system authentication prompt each time — by design.
- The panel indicator has 4 states: **green** (up), **grey** (down),
  **grey** (action in progress), **red** (error).

### Display contract

The indicator reflects **the result of the last action started from the
extension**, not the live Docker state. There is no polling and no root
process running in the background:

- At session start, the last confirmed state is restored from GSettings.
  Docker is never queried, so you never see a prompt at login.
- External changes (CLI, container crash, reboot) are **not** detected. The
  display resynchronizes on the next toggle flip — compose is idempotent, so
  flipping is always safe. The menu shows the timestamp of the last result.

## Installation

1. Install the extension from [extensions.gnome.org](https://extensions.gnome.org).
2. Open the extension preferences: the setup wizard shows a one-time command
   to install the system helper (this is the only manual step):

   ```
   sudo install -d -m 755 /usr/libexec/compose-ctl /etc/compose-ctl/conf.d
   sudo install -o root -g root -m 755 \
     ~/.local/share/gnome-shell/extensions/docker-compose-indicator@falco/system/compose-ctl \
     /usr/libexec/compose-ctl/compose-ctl
   ```

3. Follow the remaining wizard steps: choose your `docker-compose.yml`,
   register it (admin prompt), run the diagnostic (admin prompt).

The compose file path is stored in `/etc/compose-ctl/conf.d/<uid>.conf`
(root-owned, world-readable), one file per user.

## Uninstallation

```
sudo rm -rf /usr/libexec/compose-ctl /etc/compose-ctl
gnome-extensions uninstall docker-compose-indicator@falco
```

## Security model

- The entire elevated chain (script + configuration) is root-owned; nothing
  is ever executed from the extension's user-writable directory. The script
  in `system/` inside the extension is only an *installation source*.
- The extension verifies the installed script's ownership and permissions
  before every `pkexec` call.
- The configuration file is read inertly (never sourced); all invocations
  use argv arrays (no shell string interpolation).
- **Accepted risk (v1)**: the compose file itself is user-writable and its
  content (services, `env_file`, images) runs with root daemon privileges.
  Only configure compose files you trust. Hash pinning is planned for v1.1.

## Known limitations (v1)

- Targets the system Docker daemon (or Podman via `podman-compose`). Rootless
  Docker, `DOCKER_HOST` and contexts are not supported yet.
- Private registry credentials from your user `~/.docker/config.json` are
  not visible to the root client: pre-pull private images manually.
- Immutable distros (Silverblue): `/usr/libexec` is read-only — unsupported.
- Sessions without a polkit agent: use `sudo /usr/libexec/compose-ctl/compose-ctl <cmd>`
  from a terminal instead.

## Development

```
make pack          # build the EGO zip
make install-user  # install into ~/.local/share/gnome-shell/extensions
make lint          # bash -n + shellcheck + eslint (when installed)
make test          # bats test suite (mocked docker, no daemon needed)
```

Testing in a nested session: `dbus-run-session -- gnome-shell --nested --wayland`.

## Exit codes of `compose-ctl`

| Code | Meaning |
|---|---|
| 0 | Action succeeded |
| 1 | Compose action failed (total or partial) |
| 2 | Compose file missing/unreadable |
| 3 | Container daemon unreachable |
| 5 | No configuration for the calling uid |
| 6 | Wrong privilege / caller uid undeterminable |
| 7 | set-path validation failed |
| 8 | No compose binary found |

Codes 126/127 are reserved for pkexec (dialog dismissed / not authorized)
and are never emitted by the script.
