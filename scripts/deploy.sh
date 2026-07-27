#!/usr/bin/env bash
set -Eeuo pipefail
umask 0022

readonly APP_USER="tabletop"
readonly APP_GROUP="tabletop"
readonly ENVIRONMENT_FILE="/etc/tabletop/tabletop.env"
readonly REPOSITORY_DIR="/opt/tabletop/repository"
readonly RELEASES_DIR="/opt/tabletop/releases"
readonly CURRENT_LINK="/opt/tabletop/current"
readonly HEALTH_URL="http://127.0.0.1:3000/health/ready"
readonly RUSTUP_HOME_DIR="/opt/tabletop/toolchains/rustup"
readonly RUSTUP_CARGO_HOME="/opt/tabletop/toolchains/cargo"

branch="master"
revision=""
repository_url="${TABLETOP_REPOSITORY_URL:-}"
release_dir=""
previous_release=""
database_path=""
service_stopped=false
link_switched=false

usage() {
  cat <<'EOF'
Usage: deploy.sh [--branch master|develop] [--revision COMMIT] [--repository-url URL]

The default target is the latest origin/master commit. A revision must be an
ancestor of the selected remote branch.

When the repository cache is empty, provide its HTTPS URL with
--repository-url or TABLETOP_REPOSITORY_URL.
EOF
}

log() {
  printf '[tabletop-deploy] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

atomic_link() {
  local target="$1"
  local temporary_link="${CURRENT_LINK}.next.$$"
  rm -f -- "$temporary_link"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$CURRENT_LINK"
}

run_as_tabletop() {
  runuser --user "$APP_USER" -- env -i \
    HOME=/var/lib/tabletop \
    CARGO_HOME=/var/lib/tabletop/.cargo \
    CARGO_TARGET_DIR=/var/lib/tabletop/.cache/cargo-target \
    RUSTUP_HOME="$RUSTUP_HOME_DIR" \
    XDG_CACHE_HOME=/var/lib/tabletop/.cache \
    PATH="$RUSTUP_CARGO_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
    CI=1 \
    NODE_OPTIONS=--max-old-space-size=1024 \
    "$@"
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
    log "deployment failed after the service was stopped; restoring the previous release"
    systemctl stop tabletop.service >/dev/null 2>&1 || true
    if [[ -n "$previous_release" && -d "$previous_release" ]]; then
      atomic_link "$previous_release"
      systemctl start tabletop.service || true
    elif [[ "$link_switched" == true ]]; then
      rm -f -- "$CURRENT_LINK"
    fi
  fi

  log "failed release kept for diagnosis: ${release_dir:-not-created}"
  exit "$exit_code"
}

parse_arguments() {
  while (($# > 0)); do
    case "$1" in
      --branch)
        (($# >= 2)) || die "--branch requires a value"
        branch="$2"
        shift 2
        ;;
      --revision)
        (($# >= 2)) || die "--revision requires a value"
        revision="$2"
        shift 2
        ;;
      --repository-url)
        (($# >= 2)) || die "--repository-url requires a value"
        repository_url="$2"
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

  [[ "$branch" == "master" || "$branch" == "develop" ]] || \
    die "branch must be master or develop"
  if [[ -n "$revision" ]]; then
    [[ "$revision" =~ ^[A-Za-z0-9._/-]+$ && "$revision" != -* ]] || \
      die "revision contains unsupported characters"
  fi
}

load_environment() {
  local validated_database_path
  [[ -f "$ENVIRONMENT_FILE" ]] || die "missing $ENVIRONMENT_FILE; run provision-server.sh first"
  validated_database_path="$(
    local session_secret
    # Validate in a subshell so production secrets are never inherited by install, test, or build.
    # shellcheck disable=SC1090
    source "$ENVIRONMENT_FILE"
    [[ "${NODE_ENV:-}" == "production" ]] || die "NODE_ENV must be production"
    [[ "${HOST:-}" == "127.0.0.1" ]] || die "HOST must be 127.0.0.1"
    [[ "${PORT:-}" == "3000" ]] || die "PORT must be 3000 for the installed Nginx configuration"
    [[ "${DATABASE_PATH:-}" == "/var/lib/tabletop/tabletop.db" ]] || \
      die "DATABASE_PATH must match the installed systemd backup configuration"
    session_secret="${SESSION_SECRET:-}"
    [[ "$session_secret" != replace-* && ${#session_secret} -ge 32 ]] || \
      die "SESSION_SECRET has not been configured"
    printf '%s' "$DATABASE_PATH"
  )" || die "production environment validation failed"
  database_path="$validated_database_path"
}

prepare_repository() {
  if [[ ! -d "$REPOSITORY_DIR/.git" ]]; then
    [[ -z "$(find "$REPOSITORY_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || \
      die "$REPOSITORY_DIR is not empty and is not a Git repository"
    [[ -n "$repository_url" ]] || \
      die "repository URL is required when initializing the repository cache"
    log "cloning repository cache"
    git clone --filter=blob:none --no-checkout "$repository_url" "$REPOSITORY_DIR"
  elif [[ -n "$repository_url" ]]; then
    git -C "$REPOSITORY_DIR" remote set-url origin "$repository_url"
  fi

  log "fetching origin/$branch"
  git -C "$REPOSITORY_DIR" fetch --prune origin \
    "+refs/heads/$branch:refs/remotes/origin/$branch"
}

resolve_target_commit() {
  local branch_ref target
  branch_ref="refs/remotes/origin/$branch"
  target="${revision:-$branch_ref}"
  target_commit="$(git -C "$REPOSITORY_DIR" rev-parse --verify "${target}^{commit}")"
  git -C "$REPOSITORY_DIR" merge-base --is-ancestor "$target_commit" "$branch_ref" || \
    die "$target_commit is not an ancestor of origin/$branch"
}

create_release() {
  local release_name requested_rust_toolchain short_commit timestamp
  short_commit="${target_commit:0:12}"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  release_name="${timestamp}-${short_commit}"
  release_dir="$RELEASES_DIR/$release_name"

  [[ ! -e "$release_dir" ]] || die "release already exists: $release_dir"
  install -d -o root -g "$APP_GROUP" -m 0755 "$release_dir"
  git -C "$REPOSITORY_DIR" archive --format=tar "$target_commit" | tar -xf - -C "$release_dir"
  printf 'commit=%s\nbranch=%s\ncreated_at=%s\n' \
    "$target_commit" "$branch" "$timestamp" > "$release_dir/.tabletop-release"
  chown -R "$APP_USER:$APP_GROUP" "$release_dir"

  requested_rust_toolchain="$(
    sed -nE 's/^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$/\1/p' \
      "$release_dir/rust-toolchain.toml"
  )"
  [[ -n "$requested_rust_toolchain" ]] || \
    die "release rust-toolchain.toml does not pin a stable release"
  run_as_tabletop rustup run "$requested_rust_toolchain" rustc --version >/dev/null || \
    die "release Rust toolchain is not installed; rerun provision-server.sh"

  log "installing locked dependencies"
  (
    cd "$release_dir"
    run_as_tabletop pnpm install --frozen-lockfile
  )

  log "running type checks"
  (
    cd "$release_dir"
    run_as_tabletop pnpm --recursive --workspace-concurrency=1 --if-present typecheck
  )

  log "running tests"
  (
    cd "$release_dir"
    run_as_tabletop env NODE_ENV=test \
      pnpm --recursive --workspace-concurrency=1 --if-present test
  )

  log "building production artifacts"
  (
    cd "$release_dir"
    run_as_tabletop env NODE_ENV=production \
      pnpm --recursive --workspace-concurrency=1 --if-present build
  )

  [[ -r "$release_dir/apps/server/dist/main.js" ]] || die "server build output is missing"
  [[ -r "$release_dir/apps/web/dist/index.html" ]] || die "web build output is missing"
  [[ -r "$release_dir/packages/database/dist/index.js" ]] || die "database build output is missing"
}

back_up_and_migrate_database() {
  if [[ -L "$CURRENT_LINK" ]]; then
    previous_release="$(readlink -f "$CURRENT_LINK")"
  fi

  exec 8>/var/backups/tabletop/.backup.lock
  flock -w 30 8 || die "another backup or database maintenance operation is still running"

  if [[ -f "$database_path" ]]; then
    log "creating a pre-deployment database backup"
    (
      # Do not inherit a root-only caller directory into the unprivileged backup process.
      cd /
      run_as_tabletop env \
        DATABASE_PATH="$database_path" \
        BACKUP_DIR=/var/backups/tabletop \
        TABLETOP_BACKUP_LOCK_HELD=1 \
        "$release_dir/scripts/backup-db.sh" --label "predeploy-${target_commit:0:12}"
    ) >/dev/null
  fi

  log "stopping the application for migration"
  systemctl stop tabletop.service
  service_stopped=true

  log "applying database migrations"
  run_as_tabletop env DATABASE_PATH="$database_path" \
    /usr/bin/node "$release_dir/scripts/migrate-db.mjs" "$database_path"
}

activate_release() {
  atomic_link "$release_dir"
  link_switched=true
  systemctl start tabletop.service

  log "waiting for readiness"
  wait_until_ready || die "application did not become ready within 30 seconds"
  curl --fail --silent --show-error --max-time 5 --noproxy '*' \
    http://127.0.0.1/api/v1 >/dev/null
  curl --fail --silent --show-error --max-time 5 --noproxy '*' \
    http://127.0.0.1/ >/dev/null

  service_stopped=false
  log "release is healthy through both Node.js and Nginx"
}

remove_old_releases() {
  local path
  while IFS= read -r path; do
    if [[ "$path" != "$release_dir" && "$path" != "$previous_release" ]]; then
      rm -rf -- "$path" || log "WARNING: could not remove old release: $path"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print)
}

main() {
  parse_arguments "$@"
  [[ "$EUID" -eq 0 ]] || die "run this script as root"

  for command in curl flock git nginx node pnpm runuser sqlite3 systemctl tar; do
    command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
  done
  [[ -x "$RUSTUP_CARGO_HOME/bin/cargo" ]] || \
    die "Rust toolchain is missing; run provision-server.sh"
  id "$APP_USER" >/dev/null 2>&1 || die "service account does not exist; run provision-server.sh"
  [[ -f /etc/systemd/system/tabletop.service ]] || die "tabletop.service is not installed"
  nginx -t

  exec 9>/run/lock/tabletop-deploy.lock
  flock -n 9 || die "another deployment or restore is running"
  trap rollback_on_exit EXIT

  load_environment
  prepare_repository
  resolve_target_commit
  log "deploying $target_commit from origin/$branch"
  create_release
  back_up_and_migrate_database
  activate_release
  remove_old_releases

  trap - EXIT
  log "deployment complete: $target_commit"
}

main "$@"
