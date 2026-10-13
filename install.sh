#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONTROL_SERVICE="hx-pxy.service"
readonly DATAPLANE_SERVICE="hx-pxy-dataplane.service"
readonly TERMINAL_SERVICE="hx-pxy-terminal.service"
readonly SERVICE_USER="hx-pxy"
readonly SERVICE_GROUP="hx-pxy"
readonly REPOSITORY="HengXin666/hx-pxy"

INSTALL_ROOT="${HX_INSTALL_ROOT:-/usr/local/lib/hx-pxy}"
INSTALLER_PATH="${HX_INSTALLER_PATH:-/usr/local/sbin/hx-pxy-install}"
CONFIG_DIR="${HX_CONFIG_DIR:-/etc/hx-pxy}"
DATA_DIR="${HX_DATA_DIR:-/var/lib/hx-pxy}"
LOG_DIR="${HX_LOG_DIR:-/var/log/hx-pxy}"
UNIT_DIR="${HX_UNIT_DIR:-/etc/systemd/system}"
RELEASE_BASE="${HX_RELEASE_BASE:-https://github.com/${REPOSITORY}/releases}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ACTION="install"
VERSION="latest"
OFFLINE_DIR=""
BINARY_SOURCE=""
MIHOMO_SOURCE=""
WEB_SOURCE=""
OUTPUT_PATH=""
CONFIRM_PURGE="false"
START_SERVICES="true"
WORK_DIR=""

# Pre-rename identity (HX-ProxyGroup, tag v0.12.0 and earlier). An installation
# made by that release keeps its data under these paths and is served by these
# units; upgrade has to adopt it instead of starting from an empty /var/lib/hx-pxy.
readonly LEGACY_INSTALL_ROOT="/usr/local/lib/hx-proxygroup"
readonly LEGACY_INSTALLER_PATH="/usr/local/sbin/hx-proxygroup-install"
readonly LEGACY_CONFIG_DIR="/etc/hx-proxygroup"
readonly LEGACY_DATA_DIR="/var/lib/hx-proxygroup"
readonly LEGACY_LOG_DIR="/var/log/hx-proxygroup"
readonly LEGACY_SERVICE_USER="hx-proxygroup"
readonly LEGACY_SERVICE_GROUP="hx-proxygroup"
readonly LEGACY_CONTROL_SERVICE="hx-proxygroup.service"
readonly LEGACY_DATAPLANE_SERVICE="hx-proxygroup-dataplane.service"
readonly LEGACY_TERMINAL_SERVICE="hx-proxygroup-terminal.service"

# adopt_legacy_installation moves a pre-rename deployment onto the current layout.
# 见 .agents/notes/implemented/architecture/2026-10-13-upgrade-adopts-pre-rename-installation.md
#
# It is a one-way move of live data, so it runs only when the new layout is
# untouched and the old one is not: /var/lib/hx-pxy absent plus
# /var/lib/hx-proxygroup present. Anything else is left alone rather than guessed
# at. The pre-rename units are stopped first -- both generations bind
# 127.0.0.1:19090, so leaving the old control plane up would make the new one fail
# its readiness check and roll back. The old units are disabled and removed only
# after the move succeeded; a failed move restarts them and changes nothing else.
adopt_legacy_installation() {
    [[ ! -e "${DATA_DIR}" && ! -L "${DATA_DIR}" && -d "${LEGACY_DATA_DIR}" ]] || return 0
    require_root
    log "found a pre-rename installation in ${LEGACY_DATA_DIR}; adopting it"
    local was_active="false"
    if systemctl is-active --quiet "${LEGACY_CONTROL_SERVICE}"; then was_active="true"; fi
    systemctl disable --now "${LEGACY_CONTROL_SERVICE}" "${LEGACY_DATAPLANE_SERVICE}" "${LEGACY_TERMINAL_SERVICE}" >/dev/null 2>&1 || true
    if ! mv -- "${LEGACY_DATA_DIR}" "${DATA_DIR}"; then
        warn "could not move ${LEGACY_DATA_DIR} to ${DATA_DIR}"
        [[ "${was_active}" == "false" ]] || systemctl start "${LEGACY_CONTROL_SERVICE}" "${LEGACY_DATAPLANE_SERVICE}" || true
        fail "adopting the pre-rename data directory failed; nothing else was changed"
    fi
    if [[ -d "${LEGACY_CONFIG_DIR}" && ! -e "${CONFIG_DIR}" ]]; then mv -- "${LEGACY_CONFIG_DIR}" "${CONFIG_DIR}" || warn "could not move ${LEGACY_CONFIG_DIR}"; fi
    if [[ -d "${LEGACY_LOG_DIR}" && ! -e "${LOG_DIR}" ]]; then mv -- "${LEGACY_LOG_DIR}" "${LOG_DIR}" || warn "could not move ${LEGACY_LOG_DIR}"; fi
    if [[ -d "${LEGACY_INSTALL_ROOT}" && ! -e "${INSTALL_ROOT}" ]]; then mv -- "${LEGACY_INSTALL_ROOT}" "${INSTALL_ROOT}" || warn "could not move ${LEGACY_INSTALL_ROOT}"; fi
    # The pre-rename database is renamed in place as well: the new default
    # database path then finds its data instead of creating an empty database.
    local legacy_database="${DATA_DIR}/hx-proxygroup.db" suffix
    if [[ -f "${legacy_database}" && ! -e "${DATA_DIR}/hx-pxy.db" ]]; then
        for suffix in -wal -shm; do
            [[ ! -f "${legacy_database}${suffix}" ]] || mv -- "${legacy_database}${suffix}" "${DATA_DIR}/hx-pxy.db${suffix}"
        done
        mv -- "${legacy_database}" "${DATA_DIR}/hx-pxy.db"
    fi
    # The units reference the account and group by name, so they are renamed in
    # place rather than recreated -- a new account would get a new uid and the
    # adopted data would belong to nobody. If a rename fails, the files are
    # chowned to whichever name still exists instead of being left unattributed.
    local owner_user="${SERVICE_USER}" owner_group="${SERVICE_GROUP}"
    if getent group "${SERVICE_GROUP}" >/dev/null; then
        owner_group="${SERVICE_GROUP}"
    elif getent group "${LEGACY_SERVICE_GROUP}" >/dev/null; then
        if groupmod --new-name "${SERVICE_GROUP}" "${LEGACY_SERVICE_GROUP}" 2>/dev/null; then owner_group="${SERVICE_GROUP}"; else
            owner_group="${LEGACY_SERVICE_GROUP}"
            warn "could not rename group ${LEGACY_SERVICE_GROUP}; adopted files keep their current group"
        fi
    fi
    if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
        owner_user="${SERVICE_USER}"
    elif id -u "${LEGACY_SERVICE_USER}" >/dev/null 2>&1; then
        if usermod --login "${SERVICE_USER}" "${LEGACY_SERVICE_USER}" 2>/dev/null; then owner_user="${SERVICE_USER}"; else
            owner_user="${LEGACY_SERVICE_USER}"
            warn "could not rename account ${LEGACY_SERVICE_USER}; adopted files keep their current owner"
        fi
    fi
    [[ "${owner_user}" != "${SERVICE_USER}" ]] || usermod --home "${DATA_DIR}" "${SERVICE_USER}" 2>/dev/null || true
    chown -R "${owner_user}:${owner_group}" "${DATA_DIR}" 2>/dev/null || true
    rm -f -- "${UNIT_DIR}/${LEGACY_CONTROL_SERVICE}" "${UNIT_DIR}/${LEGACY_DATAPLANE_SERVICE}" "${UNIT_DIR}/${LEGACY_TERMINAL_SERVICE}" "${LEGACY_INSTALLER_PATH}"
    systemctl daemon-reload
    log "pre-rename installation adopted; data, configuration and versions were preserved"
}

log() { printf '[hx-pxy] %s\n' "$*"; }
warn() { printf '[hx-pxy] warning: %s\n' "$*" >&2; }
fail() { printf '[hx-pxy] error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Usage:
  sudo bash install.sh install   [--version VERSION] [--offline-dir DIR]
  sudo hx-pxy-install upgrade [--version VERSION]
  sudo hx-pxy-install repair|status|uninstall
  sudo hx-pxy-install backup [--output FILE]
  sudo hx-pxy-install purge --confirm-purge

Options:
  --version VERSION     Exact release tag, or latest (default).
  --offline-dir DIR     Directory containing a release bundle and SHA256SUMS.
  --binary PATH         Local hx-pxyd for a source/development install.
  --mihomo PATH         Local Mihomo binary for a source/development install.
  --web-dir DIR         Existing web/dist directory for a local install.
  --output FILE         Disaster-backup destination for the backup command.
  --no-start            Install files without enabling or starting services.
  --confirm-purge       Confirm deletion of configuration and persistent data.
  -h, --help            Show this help.

Release bundles are named hx-pxy_<tag>_linux_<amd64|arm64>.tar.gz and
contain bin/hx-pxyd, bin/mihomo, web/, deploy/systemd/, install.sh, and LICENSE.
The production unit keeps the control plane unprivileged and uses a local root
PTY helper for the administrator terminal after login and TOTP verification.
USAGE
}

parse_arguments() {
    if [[ $# -gt 0 && "${1}" != --* ]]; then ACTION="$1"; shift; fi
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version) [[ $# -ge 2 ]] || fail "--version requires a value"; VERSION="$2"; shift 2 ;;
            --offline-dir) [[ $# -ge 2 ]] || fail "--offline-dir requires a value"; OFFLINE_DIR="$2"; shift 2 ;;
            --binary) [[ $# -ge 2 ]] || fail "--binary requires a value"; BINARY_SOURCE="$2"; shift 2 ;;
            --mihomo) [[ $# -ge 2 ]] || fail "--mihomo requires a value"; MIHOMO_SOURCE="$2"; shift 2 ;;
            --web-dir) [[ $# -ge 2 ]] || fail "--web-dir requires a value"; WEB_SOURCE="$2"; shift 2 ;;
            --output) [[ $# -ge 2 ]] || fail "--output requires a value"; OUTPUT_PATH="$2"; shift 2 ;;
            --no-start) START_SERVICES="false"; shift ;;
            --confirm-purge) CONFIRM_PURGE="true"; shift ;;
            -h|--help) usage; exit 0 ;;
            *) fail "unknown option: $1" ;;
        esac
    done
    case "${ACTION}" in install|upgrade|repair|status|backup|uninstall|purge) ;; *) fail "unsupported action: ${ACTION}" ;; esac
    [[ "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "version contains unsupported characters"
}

require_root() { [[ "${EUID}" -eq 0 ]] || fail "this action must run as root"; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }
validate_version() { [[ "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "version contains unsupported characters"; }

normalize_arch() {
    case "$(uname -m)" in x86_64|amd64) printf 'amd64\n' ;; aarch64|arm64) printf 'arm64\n' ;; *) fail "unsupported architecture: $(uname -m)" ;; esac
}

check_platform() {
    [[ "$(uname -s)" == "Linux" ]] || fail "only Linux is supported"
    [[ -d /run/systemd/system ]] || fail "systemd is required"
    case "${ID:-}" in debian|ubuntu|fedora|rhel|centos|rocky|almalinux|arch|opensuse*|sles|"") ;; *) warn "distribution ${ID} is not in the validated matrix" ;; esac
    normalize_arch >/dev/null
    for command in systemctl install getent tar sha256sum; do require_command "${command}"; done
}

load_os_release() {
    ID=""
    if [[ -r /etc/os-release ]]; then
        ID="$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '\"')"
    fi
}

nologin_shell() {
    for candidate in /usr/sbin/nologin /sbin/nologin /bin/false; do
        [[ -x "${candidate}" ]] && { printf '%s\n' "${candidate}"; return; }
    done
    fail "no non-login shell is available"
}

ensure_account_and_directories() {
    getent group "${SERVICE_GROUP}" >/dev/null || groupadd --system "${SERVICE_GROUP}"
    id -u "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --gid "${SERVICE_GROUP}" --home-dir "${DATA_DIR}" --shell "$(nologin_shell)" --comment "HX-Pxy service account" "${SERVICE_USER}"
    install -d -m 0755 -o root -g root "${INSTALL_ROOT}" "${INSTALL_ROOT}/versions"
    install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${CONFIG_DIR}"
    install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${DATA_DIR}" "${DATA_DIR}/runtime" "${DATA_DIR}/snapshots" "${DATA_DIR}/artifacts" "${DATA_DIR}/backups"
    install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${LOG_DIR}"
    if [[ ! -e "${CONFIG_DIR}/config.yaml" ]]; then
        install -m 0640 -o root -g "${SERVICE_GROUP}" /dev/null "${CONFIG_DIR}/config.yaml"
    fi
    if [[ ! -e "${DATA_DIR}/runtime/active.yaml" ]]; then
        install -m 0600 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" /dev/null "${DATA_DIR}/runtime/active.yaml"
        printf '%s\n' \
            'mode: rule' 'log-level: info' \
            "external-controller-unix: ${DATA_DIR}/runtime/mihomo.sock" \
            'proxies: []' 'proxy-groups: []' 'listeners: []' 'rules:' '  - MATCH,DIRECT' \
            >"${DATA_DIR}/runtime/active.yaml"
    fi
}

resolve_latest_version() {
    require_command curl
    local effective
    effective="$(curl --fail --silent --show-error --location --max-time 20 --output /dev/null --write-out '%{url_effective}' "${RELEASE_BASE}/latest")"
    VERSION="${effective##*/tag/}"
    [[ "${VERSION}" != "${effective}" && "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "could not resolve latest release tag"
}

safe_extract_bundle() {
    local bundle="$1" destination="$2"
    if tar -tzf "${bundle}" | awk '/(^\/|(^|\/)\.\.($|\/))/ { bad=1 } END { exit bad ? 0 : 1 }'; then
        fail "release bundle contains an unsafe path"
    fi
    tar -xzf "${bundle}" -C "${destination}"
}

verify_bundle() {
    local bundle="$1" checksums="$2" name
    name="$(basename -- "${bundle}")"
    local expected
    expected="$(awk -v name="${name}" '$2 == name || $2 == "*" name {print $1; exit}' "${checksums}")"
    [[ "${expected}" =~ ^[0-9a-fA-F]{64}$ ]] || fail "SHA256SUMS has no entry for ${name}"
    local actual
    actual="$(sha256sum "${bundle}" | awk '{print $1}')"
    [[ "${actual,,}" == "${expected,,}" ]] || fail "checksum mismatch for ${name}"
}

prepare_release_stage() {
    local stage="$1" arch bundle_name bundle checksums
    arch="$(normalize_arch)"
    if [[ "${VERSION}" == "latest" ]]; then
        if [[ -n "${OFFLINE_DIR}" && -r "${OFFLINE_DIR}/VERSION" ]]; then VERSION="$(tr -d '[:space:]' <"${OFFLINE_DIR}/VERSION")"; else resolve_latest_version; fi
    fi
    validate_version
    bundle_name="hx-pxy_${VERSION}_linux_${arch}.tar.gz"
    if [[ -n "${OFFLINE_DIR}" ]]; then
        bundle="${OFFLINE_DIR}/${bundle_name}"; checksums="${OFFLINE_DIR}/SHA256SUMS"
        [[ -f "${bundle}" && -f "${checksums}" ]] || fail "offline bundle or SHA256SUMS is missing"
    else
        require_command curl
        bundle="${WORK_DIR}/${bundle_name}"; checksums="${WORK_DIR}/SHA256SUMS"
        log "downloading fixed release ${VERSION} for linux/${arch}"
        curl --fail --silent --show-error --location --max-time 120 --output "${bundle}" "${RELEASE_BASE}/download/${VERSION}/${bundle_name}"
        curl --fail --silent --show-error --location --max-time 30 --output "${checksums}" "${RELEASE_BASE}/download/${VERSION}/SHA256SUMS"
    fi
    verify_bundle "${bundle}" "${checksums}"
    safe_extract_bundle "${bundle}" "${stage}"
}

prepare_local_stage() {
    local stage="$1" backend="${BINARY_SOURCE}" mihomo="${MIHOMO_SOURCE}" web="${WEB_SOURCE}"
    if [[ -z "${backend}" ]]; then
        require_command go
        backend="${stage}/hx-pxyd.build"
        (cd "${SCRIPT_DIR}" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o "${backend}" ./cmd/hx-pxyd)
    fi
    if [[ -z "${mihomo}" ]]; then mihomo="$(command -v mihomo || true)"; fi
    [[ -x "${backend}" ]] || fail "local control-plane binary is missing or not executable"
    [[ -x "${mihomo}" ]] || fail "local Mihomo binary is required; pass --mihomo PATH"
    if [[ -z "${web}" ]]; then
        require_command npm
        (cd "${SCRIPT_DIR}/web" && [[ -d node_modules ]] || npm ci; npm run build)
        web="${SCRIPT_DIR}/web/dist"
    fi
    [[ -f "${web}/index.html" ]] || fail "web directory does not contain index.html"
    install -d -m 0755 "${stage}/bin" "${stage}/web" "${stage}/deploy/systemd"
    install -m 0755 "${backend}" "${stage}/bin/hx-pxyd"
    install -m 0755 "${mihomo}" "${stage}/bin/mihomo"
    cp -a "${web}/." "${stage}/web/"
    cp -a "${SCRIPT_DIR}/deploy/systemd/." "${stage}/deploy/systemd/"
    install -m 0755 "${SCRIPT_DIR}/install.sh" "${stage}/install.sh"
    install -m 0644 "${SCRIPT_DIR}/LICENSE" "${stage}/LICENSE"
}

validate_stage() {
    local stage="$1"
    [[ -x "${stage}/bin/hx-pxyd" ]] || fail "bundle is missing bin/hx-pxyd"
    [[ -x "${stage}/bin/mihomo" ]] || fail "bundle is missing bin/mihomo"
    [[ -f "${stage}/web/index.html" ]] || fail "bundle is missing web/index.html"
    [[ -f "${stage}/deploy/systemd/${CONTROL_SERVICE}" && -f "${stage}/deploy/systemd/${DATAPLANE_SERVICE}" && -f "${stage}/deploy/systemd/${TERMINAL_SERVICE}" ]] || fail "bundle is missing systemd units"
    [[ -f "${stage}/LICENSE" ]] || fail "bundle is missing LICENSE"
    "${stage}/bin/mihomo" -t -d "${DATA_DIR}/runtime" -f "${DATA_DIR}/runtime/active.yaml" >/dev/null
}

install_version() {
    local stage="$1" version_dir="${INSTALL_ROOT}/versions/${VERSION}"
    install -d -m 0755 -o root -g root "${version_dir}" "${version_dir}/web" "${version_dir}/deploy/systemd"
    install -m 0755 -o root -g root "${stage}/bin/hx-pxyd" "${version_dir}/hx-pxyd"
    install -m 0755 -o root -g root "${stage}/bin/mihomo" "${version_dir}/mihomo"
    cp -a "${stage}/web/." "${version_dir}/web/"
    cp -a "${stage}/deploy/systemd/." "${version_dir}/deploy/systemd/"
    install -m 0644 -o root -g root "${stage}/LICENSE" "${version_dir}/LICENSE"
    chown -R root:root "${version_dir}"
    install -m 0755 -o root -g root "${stage}/install.sh" "${INSTALLER_PATH}"
    install -m 0644 -o root -g root "${stage}/deploy/systemd/${CONTROL_SERVICE}" "${UNIT_DIR}/${CONTROL_SERVICE}"
    install -m 0644 -o root -g root "${stage}/deploy/systemd/${DATAPLANE_SERVICE}" "${UNIT_DIR}/${DATAPLANE_SERVICE}"
    install -m 0644 -o root -g root "${stage}/deploy/systemd/${TERMINAL_SERVICE}" "${UNIT_DIR}/${TERMINAL_SERVICE}"
}

switch_current() {
    local target="$1" temporary="${INSTALL_ROOT}/.current.$$"
    rm -f -- "${temporary}"
    ln -s -- "${target}" "${temporary}"
    mv -Tf -- "${temporary}" "${INSTALL_ROOT}/current"
}

wait_until_ready() {
    local attempt
    for ((attempt=1; attempt<=45; attempt++)); do
        local terminal_ready="true"
        if [[ -f "${INSTALL_ROOT}/current/deploy/systemd/${TERMINAL_SERVICE}" ]]; then
            systemctl is-active --quiet "${TERMINAL_SERVICE}" || terminal_ready="false"
        fi
        if systemctl is-active --quiet "${CONTROL_SERVICE}" && systemctl is-active --quiet "${DATAPLANE_SERVICE}" && [[ "${terminal_ready}" == "true" ]]; then
            if command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 1 http://127.0.0.1:19090/health/ready >/dev/null; then return 0; fi
        fi
        sleep 1
    done
    return 1
}

restart_services() {
    systemctl daemon-reload
    systemctl enable "${DATAPLANE_SERVICE}" "${CONTROL_SERVICE}" >/dev/null
    systemctl restart "${DATAPLANE_SERVICE}"
    if [[ -f "${INSTALL_ROOT}/current/deploy/systemd/${TERMINAL_SERVICE}" ]]; then
        systemctl enable "${TERMINAL_SERVICE}" >/dev/null
        systemctl restart "${TERMINAL_SERVICE}"
    else
        systemctl disable --now "${TERMINAL_SERVICE}" >/dev/null 2>&1 || true
    fi
    systemctl restart "${CONTROL_SERVICE}"
    wait_until_ready
}

save_previous_units() {
    local unit
    for unit in "${CONTROL_SERVICE}" "${DATAPLANE_SERVICE}" "${TERMINAL_SERVICE}"; do
        if [[ -f "${UNIT_DIR}/${unit}" ]]; then
            install -m 0644 "${UNIT_DIR}/${unit}" "${WORK_DIR}/old-${unit}"
        fi
    done
}

restore_previous_units() {
    local unit
    for unit in "${CONTROL_SERVICE}" "${DATAPLANE_SERVICE}" "${TERMINAL_SERVICE}"; do
        if [[ -f "${WORK_DIR}/old-${unit}" ]]; then
            install -m 0644 "${WORK_DIR}/old-${unit}" "${UNIT_DIR}/${unit}"
        else
            rm -f -- "${UNIT_DIR}/${unit}"
        fi
    done
}

install_or_upgrade() {
    require_root; load_os_release; check_platform
    adopt_legacy_installation
    ensure_account_and_directories
    [[ "${START_SERVICES}" == "false" ]] || require_command curl
    WORK_DIR="$(mktemp -d)"; trap '[[ -z "${WORK_DIR}" ]] || rm -rf -- "${WORK_DIR}"' EXIT
    local stage="${WORK_DIR}/stage" old_target=""
    install -d -m 0700 "${stage}"
    save_previous_units
    if [[ -n "${BINARY_SOURCE}${MIHOMO_SOURCE}${WEB_SOURCE}" || "${VERSION}" == "dev" ]]; then prepare_local_stage "${stage}"; else prepare_release_stage "${stage}"; fi
    validate_stage "${stage}"
    [[ ! -L "${INSTALL_ROOT}/current" ]] || old_target="$(readlink -f "${INSTALL_ROOT}/current" || true)"
    install_version "${stage}"
    switch_current "${INSTALL_ROOT}/versions/${VERSION}"
    if [[ "${START_SERVICES}" == "false" ]]; then systemctl daemon-reload; log "installed ${VERSION}; service start skipped"; return; fi
    if ! restart_services; then
        systemctl status "${DATAPLANE_SERVICE}" "${TERMINAL_SERVICE}" "${CONTROL_SERVICE}" --no-pager || true
        journalctl -u "${DATAPLANE_SERVICE}" -u "${TERMINAL_SERVICE}" -u "${CONTROL_SERVICE}" -n 80 --no-pager || true
        if [[ -n "${old_target}" && -d "${old_target}" ]]; then
            warn "upgrade failed; restoring ${old_target}"
            switch_current "${old_target}"
            restore_previous_units
            restart_services || warn "previous version did not recover automatically"
        fi
        fail "installation failed readiness checks"
    fi
    printf '%s\n' "${VERSION}" >"${INSTALL_ROOT}/CURRENT_VERSION"
    log "${VERSION} is ready; future updates: sudo hx-pxy-install upgrade"
}

repair_installation() {
    require_root; load_os_release; check_platform; ensure_account_and_directories
    [[ "${START_SERVICES}" == "false" ]] || require_command curl
    [[ -x "${INSTALL_ROOT}/current/hx-pxyd" && -x "${INSTALL_ROOT}/current/mihomo" ]] || fail "current version is missing; run install"
    local source="${INSTALL_ROOT}/current"
    if [[ -f "${source}/deploy/systemd/${CONTROL_SERVICE}" ]]; then
        install -m 0644 "${source}/deploy/systemd/${CONTROL_SERVICE}" "${UNIT_DIR}/${CONTROL_SERVICE}"
        install -m 0644 "${source}/deploy/systemd/${DATAPLANE_SERVICE}" "${UNIT_DIR}/${DATAPLANE_SERVICE}"
        install -m 0644 "${source}/deploy/systemd/${TERMINAL_SERVICE}" "${UNIT_DIR}/${TERMINAL_SERVICE}"
    else
        install -m 0644 "${SCRIPT_DIR}/deploy/systemd/${CONTROL_SERVICE}" "${UNIT_DIR}/${CONTROL_SERVICE}"
        install -m 0644 "${SCRIPT_DIR}/deploy/systemd/${DATAPLANE_SERVICE}" "${UNIT_DIR}/${DATAPLANE_SERVICE}"
        install -m 0644 "${SCRIPT_DIR}/deploy/systemd/${TERMINAL_SERVICE}" "${UNIT_DIR}/${TERMINAL_SERVICE}"
    fi
    "${source}/mihomo" -t -d "${DATA_DIR}/runtime" -f "${DATA_DIR}/runtime/active.yaml" >/dev/null
    [[ "${START_SERVICES}" == "false" ]] || restart_services || fail "services did not recover after repair"
    log "installation repaired"
}

backup_installation() {
    require_root; require_command tar
    local destination="${OUTPUT_PATH}"
    [[ -n "${destination}" ]] || destination="${DATA_DIR}/backups/hx-pxy-disaster-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "$(dirname -- "${destination}")"
    local was_active="false" temporary
    systemctl is-active --quiet "${CONTROL_SERVICE}" && was_active="true"
    systemctl stop "${CONTROL_SERVICE}" || true
    temporary="$(mktemp)"
    if ! tar --exclude="${DATA_DIR#/}/artifacts" --exclude="${DATA_DIR#/}/backups" -C / -czf "${temporary}" "${CONFIG_DIR#/}" "${DATA_DIR#/}" ||
       ! install -m 0600 "${temporary}" "${destination}" ||
       ! chmod 0600 "${destination}"; then
        rm -f -- "${temporary}"
        [[ "${was_active}" == "false" ]] || systemctl start "${CONTROL_SERVICE}" || true
        fail "disaster backup failed; the control-plane service was restored to its previous state"
    fi
    rm -f -- "${temporary}"
    [[ "${was_active}" == "false" ]] || systemctl start "${CONTROL_SERVICE}"
    log "disaster backup created at ${destination}; it contains secrets"
}

show_status() {
    require_command systemctl
    systemctl status "${DATAPLANE_SERVICE}" "${TERMINAL_SERVICE}" "${CONTROL_SERVICE}" --no-pager || true
    [[ ! -L "${INSTALL_ROOT}/current" ]] || log "active version: $(readlink -f "${INSTALL_ROOT}/current")"
}

uninstall_program() {
    require_root; load_os_release; check_platform
    if [[ -d "${DATA_DIR}" ]]; then backup_installation; fi
    systemctl disable --now "${CONTROL_SERVICE}" "${TERMINAL_SERVICE}" "${DATAPLANE_SERVICE}" >/dev/null 2>&1 || true
    rm -f -- "${UNIT_DIR}/${CONTROL_SERVICE}" "${UNIT_DIR}/${TERMINAL_SERVICE}" "${UNIT_DIR}/${DATAPLANE_SERVICE}" "${INSTALLER_PATH}"
    systemctl daemon-reload
    log "program removed; configuration, data, versions, and disaster backup were preserved"
}

purge_all() {
    require_root
    [[ "${CONFIRM_PURGE}" == "true" ]] || fail "purge requires --confirm-purge"
    systemctl disable --now "${CONTROL_SERVICE}" "${TERMINAL_SERVICE}" "${DATAPLANE_SERVICE}" >/dev/null 2>&1 || true
    rm -f -- "${UNIT_DIR}/${CONTROL_SERVICE}" "${UNIT_DIR}/${TERMINAL_SERVICE}" "${UNIT_DIR}/${DATAPLANE_SERVICE}" "${INSTALLER_PATH}"
    rm -rf -- "${INSTALL_ROOT}" "${CONFIG_DIR}" "${DATA_DIR}" "${LOG_DIR}"
    id -u "${SERVICE_USER}" >/dev/null 2>&1 && userdel "${SERVICE_USER}" || true
    getent group "${SERVICE_GROUP}" >/dev/null && groupdel "${SERVICE_GROUP}" || true
    systemctl daemon-reload
    log "program, configuration, persistent data, and service account purged"
}

main() {
    parse_arguments "$@"
    case "${ACTION}" in
        install|upgrade) install_or_upgrade ;; repair) repair_installation ;; status) show_status ;;
        backup) backup_installation ;; uninstall) uninstall_program ;; purge) purge_all ;;
    esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
