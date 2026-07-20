#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077

readonly DEFAULT_DATABASE_PATH="/var/lib/tabletop/tabletop.db"
readonly DEFAULT_BACKUP_DIR="/var/backups/tabletop"
readonly RETENTION_MINUTES=$((30 * 24 * 60))

label="daily"

usage() {
  cat <<'EOF'
Usage: backup-db.sh [--label LABEL]

Environment:
  DATABASE_PATH  SQLite database to back up (default: /var/lib/tabletop/tabletop.db)
  BACKUP_DIR     Backup destination (default: /var/backups/tabletop)
EOF
}

log() {
  printf '[tabletop-backup] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --label)
      (($# >= 2)) || die "--label requires a value"
      label="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || die "label contains unsupported characters"

database_path="${DATABASE_PATH:-$DEFAULT_DATABASE_PATH}"
backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"

[[ -f "$database_path" ]] || die "database does not exist: $database_path"
[[ "$backup_dir" != *"'"* && "$backup_dir" != *$'\n'* ]] || die "backup path is not supported"

install -d -m 0700 "$backup_dir"
if [[ "${TABLETOP_BACKUP_LOCK_HELD:-}" != "1" ]]; then
  exec 9>"$backup_dir/.backup.lock"
  flock -w 30 9 || die "another backup or database maintenance operation is still running"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_path="$backup_dir/tabletop-${timestamp}-${label}.sqlite3"
temporary_path="$backup_dir/.tabletop-${timestamp}-${label}.$$.tmp"

cleanup() {
  rm -f -- "$temporary_path"
}
trap cleanup EXIT

log "creating an online backup"
sqlite3 "$database_path" ".timeout 5000" ".backup '$temporary_path'"

integrity_result="$(sqlite3 -batch -noheader "$temporary_path" "PRAGMA integrity_check;")"
[[ "$integrity_result" == "ok" ]] || die "backup integrity check failed: $integrity_result"

chmod 0600 "$temporary_path"
mv -f -- "$temporary_path" "$final_path"

deleted_count=0
while IFS= read -r expired_backup; do
  rm -f -- "$expired_backup"
  deleted_count=$((deleted_count + 1))
done < <(
  find "$backup_dir" -maxdepth 1 -type f -name 'tabletop-*.sqlite3' \
    -mmin "+$RETENTION_MINUTES" -print
)

size_bytes="$(stat -c %s "$final_path")"
log "backup complete: $final_path (${size_bytes} bytes); expired files removed: $deleted_count"
printf '%s\n' "$final_path"
