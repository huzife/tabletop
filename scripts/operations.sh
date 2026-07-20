#!/usr/bin/env bash
set -Eeuo pipefail

readonly CURRENT_LINK="/opt/tabletop/current"
readonly HEALTH_URL="http://127.0.0.1:3000/health/ready"

usage() {
  cat <<'EOF'
Usage: operations.sh <command> [options]

Run this script as root on the production server after the first release.

Commands:
  status
      Show the current release, service states, backup timer state, and readiness.
  logs [tabletop|backup|nginx] [--lines N]
      Print recent journal entries. Defaults: tabletop, 200 lines.
  start
      Start tabletop.service and wait for application readiness.
  stop
      Stop tabletop.service. Active in-memory rooms and matches are terminated.
  restart
      Restart tabletop.service and wait for application readiness.
  deploy [deploy.sh options]
      Run the versioned deployment script from the current release.
  backup
      Run the configured SQLite backup service once and wait for completion.
  restore [restore-db.sh options] BACKUP_FILE
      Run the versioned interactive database restore script.

Notes:
  - start, stop, and restart only manage the Tabletop Node.js application.
    They do not stop Nginx, which may serve static files or other sites.
  - For player-facing maintenance, prefer the administrator console's site
    switch. It shows the maintenance message and closes rooms intentionally.
  - deploy and restore delegate their complete argument validation to their
    respective scripts. See docs/operations.md for supported examples.
EOF
}

log() {
  printf '[tabletop-operations] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

require_root() {
  [[ "$EUID" -eq 0 ]] || die "run this script as root"
}

require_current_release() {
  [[ -L "$CURRENT_LINK" ]] || die "no active release exists; use the bootstrap checkout's deploy.sh first"
  [[ -x "$CURRENT_LINK/scripts/deploy.sh" ]] || die "active release has no deploy script"
}

wait_until_ready() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 2 --noproxy '*' "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

unit_state() {
  local unit="$1"
  local active enabled
  active="$(systemctl is-active "$unit" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  printf '%-30s active=%-10s enabled=%s\n' "$unit" "${active:-unknown}" "${enabled:-unknown}"
}

show_status() {
  local release release_metadata
  release="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  if [[ -n "$release" && -d "$release" ]]; then
    printf 'current release: %s\n' "$release"
    release_metadata="$release/.tabletop-release"
    if [[ -r "$release_metadata" ]]; then
      sed 's/^/  /' "$release_metadata"
    fi
  else
    printf 'current release: none\n'
  fi

  unit_state tabletop.service
  unit_state nginx.service
  unit_state tabletop-backup.timer

  if [[ "$(systemctl is-active tabletop.service 2>/dev/null || true)" == "active" ]]; then
    if curl --fail --silent --show-error --max-time 2 --noproxy '*' "$HEALTH_URL" >/dev/null; then
      printf 'application readiness: ready\n'
    else
      printf 'application readiness: not ready\n'
    fi
  else
    printf 'application readiness: not checked (tabletop.service is not active)\n'
  fi
}

show_logs() {
  local target="tabletop"
  local lines="200"
  local unit

  if (($# > 0)) && [[ "$1" != "--lines" ]]; then
    target="$1"
    shift
  fi
  while (($# > 0)); do
    case "$1" in
      --lines)
        (($# >= 2)) || die "--lines requires a value"
        lines="$2"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown logs option: $1"
        ;;
    esac
  done

  [[ "$lines" =~ ^[1-9][0-9]{0,4}$ ]] || die "--lines must be an integer from 1 to 99999"
  case "$target" in
    tabletop) unit="tabletop.service" ;;
    backup) unit="tabletop-backup.service" ;;
    nginx) unit="nginx.service" ;;
    *) die "log target must be tabletop, backup, or nginx" ;;
  esac
  exec journalctl -u "$unit" -n "$lines" --no-pager
}

start_application() {
  require_current_release
  log "starting tabletop.service"
  systemctl start tabletop.service
  wait_until_ready || die "application did not become ready within 30 seconds"
  log "application is ready"
}

stop_application() {
  require_current_release
  log "stopping tabletop.service; active rooms and matches will be terminated"
  systemctl stop tabletop.service
  log "application stopped"
}

restart_application() {
  require_current_release
  log "restarting tabletop.service; active rooms and matches will be terminated"
  systemctl restart tabletop.service
  wait_until_ready || die "application did not become ready within 30 seconds"
  log "application is ready"
}

main() {
  local command="${1:-}"
  case "$command" in
    -h | --help | help | "")
      usage
      return
      ;;
  esac

  require_root
  case "$command" in
    status)
      (($# == 1)) || die "status does not accept options"
      show_status
      ;;
    logs)
      shift
      show_logs "$@"
      ;;
    start)
      (($# == 1)) || die "start does not accept options"
      start_application
      ;;
    stop)
      (($# == 1)) || die "stop does not accept options"
      stop_application
      ;;
    restart)
      (($# == 1)) || die "restart does not accept options"
      restart_application
      ;;
    deploy)
      shift
      require_current_release
      exec "$CURRENT_LINK/scripts/deploy.sh" "$@"
      ;;
    backup)
      (($# == 1)) || die "backup does not accept options"
      require_current_release
      systemctl start tabletop-backup.service
      log "backup service completed"
      ;;
    restore)
      shift
      require_current_release
      exec "$CURRENT_LINK/scripts/restore-db.sh" "$@"
      ;;
    *)
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
