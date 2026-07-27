#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_USER="tabletop"
readonly APP_GROUP="tabletop"
readonly NODE_MAJOR="22"
readonly NODE_MIN_MINOR="16"
readonly PNPM_VERSION="11.13.1"
readonly RUSTUP_HOME_DIR="/opt/tabletop/toolchains/rustup"
readonly RUSTUP_CARGO_HOME="/opt/tabletop/toolchains/cargo"
readonly SWAP_FILE="/swapfile-tabletop"
readonly SWAP_SIZE_MIB="2048"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
deploy_dir="$project_root/deploy"

log() {
  printf '[tabletop-provision] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "run this script as root"
}

require_assets() {
  local asset
  for asset in \
    "$project_root/rust-toolchain.toml" \
    "$deploy_dir/tabletop.env.example" \
    "$deploy_dir/nginx/tabletop.conf" \
    "$deploy_dir/nginx/tabletop-server.conf" \
    "$deploy_dir/systemd/tabletop.service" \
    "$deploy_dir/systemd/tabletop-backup.service" \
    "$deploy_dir/systemd/tabletop-backup.timer"; do
    [[ -f "$asset" ]] || die "missing deployment asset: $asset"
  done
}

check_operating_system() {
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "22.04" ]] || \
    die "this provisioner supports Ubuntu 22.04 only"
}

install_system_packages() {
  log "installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    gnupg \
    nginx \
    openssl \
    sqlite3 \
    ufw
}

install_node_and_pnpm() {
  local architecture current_major current_minor key_asc key_gpg
  architecture="$(dpkg --print-architecture)"
  key_asc="$(mktemp)"
  key_gpg="$(mktemp)"

  log "configuring the NodeSource Node.js ${NODE_MAJOR}.x repository"
  curl --fail --silent --show-error --location \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    --output "$key_asc"
  gpg --batch --yes --dearmor --output "$key_gpg" "$key_asc"
  install -d -m 0755 /etc/apt/keyrings
  install -o root -g root -m 0644 "$key_gpg" /etc/apt/keyrings/nodesource.gpg
  rm -f -- "$key_asc" "$key_gpg"
  printf 'deb [arch=%s signed-by=%s] %s/node_%s.x nodistro main\n' \
    "$architecture" "/etc/apt/keyrings/nodesource.gpg" "https://deb.nodesource.com" \
    "$NODE_MAJOR" > /etc/apt/sources.list.d/nodesource.list

  apt-get update
  if dpkg-query -W -f='${Status}' libnode-dev 2>/dev/null | grep -Fq 'install ok installed'; then
    log "removing distribution libnode-dev before the NodeSource upgrade"
    apt-get remove -y libnode-dev
  fi
  apt-get install -y --allow-downgrades nodejs

  current_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  current_minor="$(node --version | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')"
  [[ "$current_major" == "$NODE_MAJOR" && "$current_minor" -ge "$NODE_MIN_MINOR" ]] || \
    die "expected Node.js >=${NODE_MAJOR}.${NODE_MIN_MINOR}; found $(node --version)"

  if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != "$PNPM_VERSION" ]]; then
    log "installing pnpm $PNPM_VERSION"
    npm install --global "pnpm@$PNPM_VERSION"
  fi
}

install_rust_toolchain() {
  local rust_toolchain rustup_init

  rust_toolchain="$(
    sed -nE 's/^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$/\1/p' \
      "$project_root/rust-toolchain.toml"
  )"
  [[ -n "$rust_toolchain" ]] || die "rust-toolchain.toml must pin a stable release"
  install -d -o root -g root -m 0755 "$RUSTUP_HOME_DIR" "$RUSTUP_CARGO_HOME"
  if [[ ! -x "$RUSTUP_CARGO_HOME/bin/rustup" ]]; then
    rustup_init="$(mktemp)"
    log "installing the pinned Rust toolchain manager"
    curl --fail --silent --show-error --location \
      https://sh.rustup.rs \
      --output "$rustup_init"
    env \
      CARGO_HOME="$RUSTUP_CARGO_HOME" \
      RUSTUP_HOME="$RUSTUP_HOME_DIR" \
      sh "$rustup_init" -y --no-modify-path --profile minimal --default-toolchain none
    rm -f -- "$rustup_init"
  fi

  log "installing Rust $rust_toolchain with the WebAssembly target"
  env \
    CARGO_HOME="$RUSTUP_CARGO_HOME" \
    RUSTUP_HOME="$RUSTUP_HOME_DIR" \
    "$RUSTUP_CARGO_HOME/bin/rustup" toolchain install "$rust_toolchain" \
      --profile minimal \
      --component clippy \
      --component rustfmt \
      --target wasm32-unknown-unknown
  env \
    CARGO_HOME="$RUSTUP_CARGO_HOME" \
    RUSTUP_HOME="$RUSTUP_HOME_DIR" \
    "$RUSTUP_CARGO_HOME/bin/rustup" default "$rust_toolchain"
  chmod -R a+rX,go-w "$RUSTUP_HOME_DIR" "$RUSTUP_CARGO_HOME"
}

create_service_account_and_directories() {
  local existing_group existing_home existing_shell passwd_entry
  if ! getent group "$APP_GROUP" >/dev/null; then
    groupadd --system "$APP_GROUP"
  fi
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir /var/lib/tabletop \
      --shell /usr/sbin/nologin "$APP_USER"
  else
    passwd_entry="$(getent passwd "$APP_USER")"
    IFS=: read -r _ _ _ _ _ existing_home existing_shell <<< "$passwd_entry"
    existing_group="$(id -gn "$APP_USER")"
    [[ "$existing_group" == "$APP_GROUP" ]] || \
      die "existing $APP_USER user has unexpected primary group: $existing_group"
    [[ "$existing_home" == "/var/lib/tabletop" ]] || \
      die "existing $APP_USER user has unexpected home: $existing_home"
    [[ "$existing_shell" == "/usr/sbin/nologin" ]] || \
      die "existing $APP_USER user has unexpected shell: $existing_shell"
  fi

  install -d -o root -g "$APP_GROUP" -m 0755 /opt/tabletop
  install -d -o root -g root -m 0755 /opt/tabletop/repository
  install -d -o root -g "$APP_GROUP" -m 0755 /opt/tabletop/releases
  install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 /var/lib/tabletop
  install -d -o "$APP_USER" -g "$APP_GROUP" -m 0700 /var/backups/tabletop
  install -d -o root -g "$APP_GROUP" -m 0750 /etc/tabletop
  if [[ ! -e /var/backups/tabletop/.backup.lock ]]; then
    install -o "$APP_USER" -g "$APP_GROUP" -m 0600 /dev/null \
      /var/backups/tabletop/.backup.lock
  else
    chown "$APP_USER:$APP_GROUP" /var/backups/tabletop/.backup.lock
    chmod 0600 /var/backups/tabletop/.backup.lock
  fi
}

create_environment_file() {
  local environment_file session_secret temporary_file
  environment_file="/etc/tabletop/tabletop.env"

  if [[ -e "$environment_file" ]]; then
    log "keeping existing $environment_file"
    chown root:"$APP_GROUP" "$environment_file"
    chmod 0640 "$environment_file"
    return
  fi

  session_secret="$(openssl rand -hex 32)"
  temporary_file="$(mktemp)"
  sed "s|^SESSION_SECRET=.*$|SESSION_SECRET=$session_secret|" \
    "$deploy_dir/tabletop.env.example" > "$temporary_file"
  install -o root -g "$APP_GROUP" -m 0640 "$temporary_file" "$environment_file"
  rm -f -- "$temporary_file"
  log "created $environment_file with a locally generated session secret"
}

configure_swap() {
  local swap_type

  if [[ -e "$SWAP_FILE" ]]; then
    swap_type="$(blkid -p -s TYPE -o value "$SWAP_FILE" 2>/dev/null || true)"
    [[ "$swap_type" == "swap" ]] || die "$SWAP_FILE exists but is not a swap file"
  else
    log "creating ${SWAP_SIZE_MIB} MiB swap file"
    fallocate -l "${SWAP_SIZE_MIB}M" "$SWAP_FILE"
    chmod 0600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
  fi

  if ! swapon --show=NAME --noheadings | \
    sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -Fxq "$SWAP_FILE"; then
    swapon "$SWAP_FILE"
  fi
  if ! awk -v swap_file="$SWAP_FILE" '$1 == swap_file { found = 1 } END { exit !found }' /etc/fstab; then
    printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> /etc/fstab
  fi

  printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-tabletop-swap.conf
  sysctl --system >/dev/null
}

install_service_configuration() {
  log "installing Nginx and systemd configuration"
  install -d -o root -g root -m 0755 /etc/nginx/snippets
  install -o root -g root -m 0644 "$deploy_dir/nginx/tabletop-server.conf" \
    /etc/nginx/snippets/tabletop-server.conf
  install -o root -g root -m 0644 "$deploy_dir/nginx/tabletop.conf" \
    /etc/nginx/sites-available/tabletop.conf
  ln -sfn /etc/nginx/sites-available/tabletop.conf /etc/nginx/sites-enabled/tabletop.conf
  if [[ -e /etc/nginx/sites-enabled/default || -L /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi

  install -o root -g root -m 0644 "$deploy_dir/systemd/tabletop.service" \
    /etc/systemd/system/tabletop.service
  install -o root -g root -m 0644 "$deploy_dir/systemd/tabletop-backup.service" \
    /etc/systemd/system/tabletop-backup.service
  install -o root -g root -m 0644 "$deploy_dir/systemd/tabletop-backup.timer" \
    /etc/systemd/system/tabletop-backup.timer

  nginx -t
  systemctl daemon-reload
  systemctl enable tabletop.service
  systemctl enable --now tabletop-backup.timer
  systemctl enable --now nginx.service
  systemctl reload nginx.service
}

configure_firewall() {
  log "allowing SSH, HTTP, and HTTPS through UFW"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
}

main() {
  require_root
  require_assets
  check_operating_system
  install_system_packages
  install_node_and_pnpm
  create_service_account_and_directories
  install_rust_toolchain
  create_environment_file
  configure_swap
  install_service_configuration
  configure_firewall

  log "provisioning complete"
  log "review /etc/tabletop/tabletop.env, then run scripts/deploy.sh"
}

main "$@"
