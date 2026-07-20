#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_USER="tabletop"
readonly ENVIRONMENT_FILE="/etc/tabletop/tabletop.env"
readonly CURRENT_LINK="/opt/tabletop/current"
readonly HEALTH_URL="http://127.0.0.1:3000/health/ready"

assume_yes=false
backup_path=""
pre_restore_backup=""
database_replaced=false
service_stopped=false

usage() {
  cat <<'EOF'
Usage: restore-db.sh [--yes] BACKUP_FILE

The service is stopped during restore. The current database is backed up first
and restored automatically if migration or the readiness check fails.
EOF
}

log() {
  printf '[tabletop-restore] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

run_as_tabletop() {
  runuser --user "$APP_USER" -- env HOME=/var/lib/tabletop "$@"
}

install_database_file() {
  local source_file="$1"
  local temporary_file="${DATABASE_PATH}.restore.$$"

  install -o tabletop -g tabletop -m 0600 "$source_file" "$temporary_file"
  rm -f -- "${DATABASE_PATH}-wal" "${DATABASE_PATH}-shm"
  mv -f -- "$temporary_file" "$DATABASE_PATH"
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

rollback_on_exit() {
  local exit_code=$?
  trap - EXIT

  if ((exit_code == 0)); then
    return
  fi

  if [[ "$service_stopped" == true ]]; then
    systemctl stop tabletop.service >/dev/null 2>&1 || true
    if [[ "$database_replaced" == true && -n "$pre_restore_backup" && -f "$pre_restore_backup" ]]; then
      log "restore failed; putting the pre-restore database back"
      install_database_file "$pre_restore_backup"
      systemctl start tabletop.service || true
    else
      log "restore failed; the service remains stopped"
    fi
  fi
  exit "$exit_code"
}

parse_arguments() {
  while (($# > 0)); do
    case "$1" in
      --yes)
        assume_yes=true
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*)
        die "unknown argument: $1"
        ;;
      *)
        [[ -z "$backup_path" ]] || die "only one backup file may be supplied"
        backup_path="$1"
        shift
        ;;
    esac
  done
  [[ -n "$backup_path" ]] || die "a backup file is required"
}

main() {
  local answer integrity_result
  parse_arguments "$@"
  [[ "$EUID" -eq 0 ]] || die "run this script as root"
  [[ -f "$backup_path" ]] || die "backup does not exist: $backup_path"
  backup_path="$(readlink -f "$backup_path")"
  [[ -L "$CURRENT_LINK" ]] || die "there is no active Tabletop release"
  [[ -f "$ENVIRONMENT_FILE" ]] || die "missing $ENVIRONMENT_FILE"

  # shellcheck disable=SC1090
  set -a
  source "$ENVIRONMENT_FILE"
  set +a
  [[ -n "${DATABASE_PATH:-}" ]] || die "DATABASE_PATH is required"

  integrity_result="$(sqlite3 -batch -noheader "$backup_path" "PRAGMA integrity_check;")"
  [[ "$integrity_result" == "ok" ]] || die "backup integrity check failed: $integrity_result"

  if [[ "$assume_yes" != true ]]; then
    printf 'Restore %s to %s? Type yes to continue: ' "$backup_path" "$DATABASE_PATH"
    read -r answer
    [[ "$answer" == "yes" ]] || die "restore cancelled"
  fi

  exec 9>/run/lock/tabletop-deploy.lock
  flock -n 9 || die "another deployment or restore is running"
  exec 8>/var/backups/tabletop/.backup.lock
  flock -w 30 8 || die "another backup or database maintenance operation is still running"
  trap rollback_on_exit EXIT

  if [[ -f "$DATABASE_PATH" ]]; then
    pre_restore_backup="$(
      # Do not inherit a root-only caller directory into the unprivileged backup process.
      cd /
      run_as_tabletop env \
        DATABASE_PATH="$DATABASE_PATH" \
        BACKUP_DIR=/var/backups/tabletop \
        TABLETOP_BACKUP_LOCK_HELD=1 \
        "$CURRENT_LINK/scripts/backup-db.sh" --label pre-restore
    )"
  fi

  systemctl stop tabletop.service
  service_stopped=true
  install_database_file "$backup_path"
  database_replaced=true

  run_as_tabletop env DATABASE_PATH="$DATABASE_PATH" \
    /usr/bin/node "$CURRENT_LINK/scripts/migrate-db.mjs" "$DATABASE_PATH"
  systemctl start tabletop.service
  wait_until_ready || die "restored service did not become ready within 30 seconds"

  service_stopped=false
  trap - EXIT
  log "database restored successfully from $backup_path"
}

main "$@"
