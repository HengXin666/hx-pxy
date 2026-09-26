#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="dev"
LISTEN_ADDRESS=""
DATA_DIR="${SCRIPT_DIR}/.tmp/run-data"
RUN_DIR="${SCRIPT_DIR}/.tmp/run"
FRONTEND_DIR="${SCRIPT_DIR}/web"
FRONTEND_HOST="127.0.0.1"
FRONTEND_PORT=""
MIHOMO_BINARY="mihomo"
BINARY_SOURCE=""
BACKEND_ONLY="false"
REQUIRE_FRONTEND="false"
INSTALL_FRONTEND_DEPS="true"
RANDOM_PORT_MIN=49152
RANDOM_PORT_MAX=65535

BACKEND_BINARY=""
BACKEND_PID=""
BACKEND_PROCESS_GROUP=""
FRONTEND_PID=""
FRONTEND_PROCESS_GROUP=""
BACKEND_EXIT_STATUS=""
FRONTEND_EXIT_STATUS=""
RUN_LOG="${RUN_DIR}/run.log"
BACKEND_LOG="${RUN_DIR}/logs/backend.log"
FRONTEND_LOG="${RUN_DIR}/logs/frontend.log"

append_run_log() {
    local line="$1"
    [[ -d "${RUN_DIR}" ]] || return 0
    printf '%s\n' "${line}" >>"${RUN_LOG}" 2>/dev/null || true
}

timestamp() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
    local line="[$(timestamp)] [hx-proxygroup] $*"
    printf '%s\n' "${line}"
    append_run_log "${line}"
}

warn() {
    local line="[$(timestamp)] [hx-proxygroup] warning: $*"
    printf '%s\n' "${line}" >&2
    append_run_log "${line}"
}

fail() {
    local line="[$(timestamp)] [hx-proxygroup] error: $*"
    printf '%s\n' "${line}" >&2
    append_run_log "${line}"
    exit 1
}

usage() {
    cat <<'USAGE'
Usage:
  ./run.sh [options]

Starts HX-ProxyGroup locally without root, systemd, service users, or files under
/usr/local, /etc, /var/lib, and /var/log. Ctrl+C stops all child processes.

Options:
  --version VERSION          Backend build version. Default: dev
  --binary PATH              Run an existing hx-proxygroupd binary.
  --listen ADDRESS           Backend listen address. Default: random loopback high port
  --data-dir PATH            Local runtime data. Default: ./.tmp/run-data
  --frontend-dir PATH        React project directory. Default: ./web
  --frontend-host HOST       Frontend development host. Default: 127.0.0.1
  --frontend-port PORT       Frontend development port. Default: random high port
  --mihomo PATH              Mihomo executable path or command name. Default: mihomo
  --backend-only             Do not discover or start the frontend.
  --require-frontend         Fail when frontend/package.json is absent.
  --install-frontend-deps    Install local frontend dependencies when missing (default).
  --no-install-frontend-deps Fail instead of installing when node_modules is missing.
  -h, --help                 Show this help.

The React frontend is discovered from web/package.json and starts automatically.
When dependencies are missing, run.sh installs them from the lock file before
starting Vite. Random defaults are selected from ports 49152-65535. Explicit
ports remain supported; an occupied frontend port advances up to 20 ports.
USAGE
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

tcp_port_in_use() {
    local host="$1"
    local port="$2"
    (exec 9<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

find_available_random_high_port() {
    local host="$1"
    local attempt
    local candidate
    local range=$((RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1))
    for ((attempt = 1; attempt <= 128; attempt++)); do
        candidate=$((RANDOM_PORT_MIN + (((RANDOM << 15) | RANDOM) % range)))
        if ! tcp_port_in_use "${host}" "${candidate}"; then
            printf '%d\n' "${candidate}"
            return
        fi
    done
    fail "could not find an available high port between ${RANDOM_PORT_MIN} and ${RANDOM_PORT_MAX}"
}

assign_random_backend_address_if_needed() {
    if [[ -z "${LISTEN_ADDRESS}" ]]; then
        LISTEN_ADDRESS="127.0.0.1:$(find_available_random_high_port 127.0.0.1)"
    fi
}

backend_address_in_use() {
    local host
    local port
    if [[ "${LISTEN_ADDRESS}" =~ ^\[([^]]+)\]:([0-9]+)$ ]]; then
        host="${BASH_REMATCH[1]}"
        port="${BASH_REMATCH[2]}"
    elif [[ "${LISTEN_ADDRESS}" =~ ^([^:]+):([0-9]+)$ ]]; then
        host="${BASH_REMATCH[1]}"
        port="${BASH_REMATCH[2]}"
    else
        return 1
    fi

    tcp_port_in_use "${host}" "${port}"
}

ensure_backend_address_available() {
    if backend_address_in_use; then
        fail "backend address ${LISTEN_ADDRESS} is already in use; stop the existing service or choose another address with --listen"
    fi
}

absolute_path() {
    local value="$1"
    if [[ "${value}" == /* ]]; then
        printf '%s\n' "${value}"
    else
        printf '%s\n' "${SCRIPT_DIR}/${value#./}"
    fi
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version)
                [[ $# -ge 2 ]] || fail "--version requires a value"
                VERSION="$2"
                shift 2
                ;;
            --binary)
                [[ $# -ge 2 ]] || fail "--binary requires a path"
                BINARY_SOURCE="$(absolute_path "$2")"
                shift 2
                ;;
            --listen)
                [[ $# -ge 2 ]] || fail "--listen requires a value"
                LISTEN_ADDRESS="$2"
                shift 2
                ;;
            --data-dir)
                [[ $# -ge 2 ]] || fail "--data-dir requires a value"
                DATA_DIR="$(absolute_path "$2")"
                shift 2
                ;;
            --frontend-dir)
                [[ $# -ge 2 ]] || fail "--frontend-dir requires a value"
                FRONTEND_DIR="$(absolute_path "$2")"
                shift 2
                ;;
            --frontend-host)
                [[ $# -ge 2 ]] || fail "--frontend-host requires a value"
                FRONTEND_HOST="$2"
                shift 2
                ;;
            --frontend-port)
                [[ $# -ge 2 ]] || fail "--frontend-port requires a value"
                FRONTEND_PORT="$2"
                shift 2
                ;;
            --mihomo)
                [[ $# -ge 2 ]] || fail "--mihomo requires a value"
                MIHOMO_BINARY="$2"
                shift 2
                ;;
            --backend-only)
                BACKEND_ONLY="true"
                shift
                ;;
            --require-frontend)
                REQUIRE_FRONTEND="true"
                shift
                ;;
            --install-frontend-deps)
                INSTALL_FRONTEND_DEPS="true"
                shift
                ;;
            --no-install-frontend-deps)
                INSTALL_FRONTEND_DEPS="false"
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                fail "unknown option: $1"
                ;;
        esac
    done

    [[ "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "version contains unsupported characters"
    [[ -n "${MIHOMO_BINARY// }" ]] || fail "mihomo executable cannot be empty"
    if [[ -n "${FRONTEND_PORT}" ]]; then
        [[ "${FRONTEND_PORT}" =~ ^[0-9]+$ ]] || fail "frontend port must be an integer"
        ((FRONTEND_PORT >= 1 && FRONTEND_PORT <= 65535)) || fail "frontend port must be between 1 and 65535"
    fi
    if [[ "${BACKEND_ONLY}" == "true" && "${REQUIRE_FRONTEND}" == "true" ]]; then
        fail "--backend-only and --require-frontend cannot be used together"
    fi
    assign_random_backend_address_if_needed
}

prepare_local_directories() {
    mkdir -p \
        "${RUN_DIR}/bin" \
        "${RUN_DIR}/logs" \
        "${DATA_DIR}/artifacts" \
        "${DATA_DIR}/runtime" \
        "${DATA_DIR}/snapshots" \
        "${DATA_DIR}/state" \
        "${DATA_DIR}/tmp"
    chmod 0700 \
        "${RUN_DIR}" \
        "${RUN_DIR}/bin" \
        "${RUN_DIR}/logs" \
        "${DATA_DIR}" \
        "${DATA_DIR}/artifacts" \
        "${DATA_DIR}/runtime" \
        "${DATA_DIR}/snapshots" \
        "${DATA_DIR}/state" \
        "${DATA_DIR}/tmp"
    touch "${RUN_LOG}" "${BACKEND_LOG}" "${FRONTEND_LOG}"
    chmod 0600 "${RUN_LOG}" "${BACKEND_LOG}" "${FRONTEND_LOG}"

    local config_path="${RUN_DIR}/config.yaml"
    if [[ ! -e "${config_path}" ]]; then
        printf '%s\n' '# Local run placeholder; structured configuration loading is not implemented yet.' >"${config_path}"
        chmod 0600 "${config_path}"
    fi
}

build_or_copy_backend() {
    BACKEND_BINARY="${RUN_DIR}/bin/hx-proxygroupd"
    if [[ -n "${BINARY_SOURCE}" ]]; then
        [[ -f "${BINARY_SOURCE}" ]] || fail "binary does not exist: ${BINARY_SOURCE}"
        [[ -x "${BINARY_SOURCE}" ]] || fail "binary is not executable: ${BINARY_SOURCE}"
        cp -- "${BINARY_SOURCE}" "${BACKEND_BINARY}"
        chmod 0755 "${BACKEND_BINARY}"
        return
    fi

    require_command go
    log "building backend version ${VERSION}"
    (
        cd "${SCRIPT_DIR}"
        CGO_ENABLED=0 go build \
            -trimpath \
            -ldflags "-s -w -X main.version=${VERSION}" \
            -o "${BACKEND_BINARY}" \
            ./cmd/hx-proxygroupd
    ) 2>&1 | tee -a "${RUN_LOG}"
    chmod 0755 "${BACKEND_BINARY}"
}

start_backend() {
    local binary="$1"
    log "starting backend at http://${LISTEN_ADDRESS}"
    log "backend log: ${BACKEND_LOG}"
    setsid "${binary}" \
        --listen "${LISTEN_ADDRESS}" \
        --data-dir "${DATA_DIR}" \
        --config "${RUN_DIR}/config.yaml" \
        --database "${DATA_DIR}/hx-proxygroup.db" \
        --master-key "${DATA_DIR}/master.key" \
        --runtime-config "${DATA_DIR}/runtime/active.yaml" \
        --snapshots "${DATA_DIR}/snapshots" \
        --mihomo "${MIHOMO_BINARY}" >>"${BACKEND_LOG}" 2>&1 &
    BACKEND_PID="$!"
    BACKEND_PROCESS_GROUP="${BACKEND_PID}"
    chmod 0600 "${BACKEND_LOG}"
}

wait_for_backend() {
    local health_url="http://${LISTEN_ADDRESS}/health/ready"
    local attempt
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl is unavailable; backend readiness check skipped"
        sleep 1
        kill -0 "${BACKEND_PID}" 2>/dev/null || fail "backend exited during startup"
        return
    fi

    for ((attempt = 1; attempt <= 30; attempt++)); do
        if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
            set +e
            wait "${BACKEND_PID}"
            local backend_status="$?"
            set -e
            record_child_exit backend "${BACKEND_PID}" "${backend_status}"
            fail "backend exited before becoming ready; see ${BACKEND_LOG}"
        fi
        if curl --fail --silent --show-error --max-time 1 "${health_url}" >/dev/null 2>&1; then
            sleep 0.1
            if kill -0 "${BACKEND_PID}" 2>/dev/null && \
                curl --fail --silent --show-error --max-time 1 "${health_url}" >/dev/null 2>&1; then
                log "backend is ready"
                return
            fi
        fi
        sleep 1
    done
    fail "backend did not become ready at ${health_url}; see ${BACKEND_LOG}"
}

detect_frontend_package_manager() {
    if [[ -f "${FRONTEND_DIR}/pnpm-lock.yaml" ]]; then
        printf '%s\n' pnpm
    elif [[ -f "${FRONTEND_DIR}/yarn.lock" ]]; then
        printf '%s\n' yarn
    elif [[ -f "${FRONTEND_DIR}/bun.lock" || -f "${FRONTEND_DIR}/bun.lockb" ]]; then
        printf '%s\n' bun
    else
        printf '%s\n' npm
    fi
}

install_frontend_dependencies() {
    local package_manager="$1"
    log "installing frontend dependencies with ${package_manager}"
    case "${package_manager}" in
        pnpm)
            (cd "${FRONTEND_DIR}" && pnpm install --frozen-lockfile) 2>&1 | tee -a "${RUN_LOG}"
            ;;
        yarn)
            (cd "${FRONTEND_DIR}" && yarn install --frozen-lockfile) 2>&1 | tee -a "${RUN_LOG}"
            ;;
        bun)
            (cd "${FRONTEND_DIR}" && bun install --frozen-lockfile) 2>&1 | tee -a "${RUN_LOG}"
            ;;
        npm)
            if [[ -f "${FRONTEND_DIR}/package-lock.json" ]]; then
                (cd "${FRONTEND_DIR}" && npm ci) 2>&1 | tee -a "${RUN_LOG}"
            else
                (cd "${FRONTEND_DIR}" && npm install) 2>&1 | tee -a "${RUN_LOG}"
            fi
            ;;
        *)
            fail "unsupported frontend package manager: ${package_manager}"
            ;;
    esac
}

start_frontend_if_available() {
    if [[ "${BACKEND_ONLY}" == "true" ]]; then
        log "frontend disabled by --backend-only"
        return
    fi
    if [[ ! -f "${FRONTEND_DIR}/package.json" ]]; then
        if [[ "${REQUIRE_FRONTEND}" == "true" ]]; then
            fail "frontend package.json not found: ${FRONTEND_DIR}/package.json"
        fi
        warn "frontend package.json is missing; backend continues without the management UI"
        return
    fi

    local package_manager
    package_manager="$(detect_frontend_package_manager)"
    require_command "${package_manager}"
    if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
        if [[ "${INSTALL_FRONTEND_DEPS}" != "true" ]]; then
            fail "frontend dependencies are missing; rerun with --install-frontend-deps"
        fi
        install_frontend_dependencies "${package_manager}"
    fi

    local probe_host="${FRONTEND_HOST}"
    if [[ "${probe_host}" == "0.0.0.0" || "${probe_host}" == "::" ]]; then
        probe_host="127.0.0.1"
    fi
    if [[ -z "${FRONTEND_PORT}" ]]; then
        FRONTEND_PORT="$(find_available_random_high_port "${probe_host}")"
    else
        local requested_port="${FRONTEND_PORT}"
        local maximum_port=$((requested_port + 20))
        ((maximum_port > 65535)) && maximum_port=65535
        while ((FRONTEND_PORT <= maximum_port)); do
            if ! tcp_port_in_use "${probe_host}" "${FRONTEND_PORT}"; then
                break
            fi
            FRONTEND_PORT=$((FRONTEND_PORT + 1))
        done
        if ((FRONTEND_PORT > maximum_port)); then
            fail "no available frontend port between ${requested_port} and ${maximum_port}"
        fi
        if [[ "${FRONTEND_PORT}" != "${requested_port}" ]]; then
            warn "frontend port ${requested_port} is in use; using ${FRONTEND_PORT} instead"
        fi
    fi

    local api_base="http://${LISTEN_ADDRESS}"
    log "starting frontend at http://${FRONTEND_HOST}:${FRONTEND_PORT}"
    log "frontend log: ${FRONTEND_LOG}"
    (
        cd "${FRONTEND_DIR}"
        export VITE_BACKEND_TARGET="${api_base}"
        exec setsid "${package_manager}" run dev -- \
            --host "${FRONTEND_HOST}" \
            --port "${FRONTEND_PORT}" \
            --strictPort \
            --clearScreen false
    ) >>"${FRONTEND_LOG}" 2>&1 &
    FRONTEND_PID="$!"
    FRONTEND_PROCESS_GROUP="${FRONTEND_PID}"
    chmod 0600 "${FRONTEND_LOG}"
}

process_group_exists() {
    local process_group="$1"
    [[ -n "${process_group}" ]] && kill -0 -- "-${process_group}" 2>/dev/null
}

signal_process_group() {
    local signal="$1"
    local process_group="$2"
    if process_group_exists "${process_group}"; then
        kill "-${signal}" -- "-${process_group}" 2>/dev/null || true
    fi
}

record_child_exit() {
    local name="$1"
    local pid="$2"
    local status="$3"
    local log_path="${BACKEND_LOG}"
    if [[ "${name}" == "frontend" ]]; then
        FRONTEND_EXIT_STATUS="${status}"
        log_path="${FRONTEND_LOG}"
    else
        BACKEND_EXIT_STATUS="${status}"
    fi
    log "${name} process exited (pid=${pid}, status=${status}); log=${log_path}"
}

wait_for_process_group() {
    local name="$1"
    local process_group="$2"
    local attempt
    if ! process_group_exists "${process_group}"; then
        return
    fi

    for ((attempt = 1; attempt <= 100; attempt++)); do
        if ! process_group_exists "${process_group}"; then
            return
        fi
        sleep 0.1
    done

    warn "${name} process group did not stop after 10 seconds; sending SIGKILL"
    kill -KILL -- "-${process_group}" 2>/dev/null || true
}

cleanup() {
    local status="$?"
    trap - EXIT INT TERM HUP

    log "local run stopping (status=${status})"

    signal_process_group TERM "${FRONTEND_PROCESS_GROUP}"
    signal_process_group TERM "${BACKEND_PROCESS_GROUP}"
    wait_for_process_group frontend "${FRONTEND_PROCESS_GROUP}"
    wait_for_process_group backend "${BACKEND_PROCESS_GROUP}"

    if [[ -n "${FRONTEND_PID}" && -z "${FRONTEND_EXIT_STATUS}" ]]; then
        set +e
        wait "${FRONTEND_PID}" 2>/dev/null
        local frontend_status="$?"
        set -e
        record_child_exit frontend "${FRONTEND_PID}" "${frontend_status}"
    fi
    if [[ -n "${BACKEND_PID}" && -z "${BACKEND_EXIT_STATUS}" ]]; then
        set +e
        wait "${BACKEND_PID}" 2>/dev/null
        local backend_status="$?"
        set -e
        record_child_exit backend "${BACKEND_PID}" "${backend_status}"
    fi
    log "local run exited (status=${status})"
    exit "${status}"
}

wait_for_children() {
    local status=0
    local exited_pid=""
    set +e
    if [[ -n "${FRONTEND_PID}" ]]; then
        if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
            wait -n -p exited_pid "${BACKEND_PID}" "${FRONTEND_PID}"
        else
            wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
        fi
        status="$?"
        if [[ "${exited_pid}" == "${BACKEND_PID}" ]]; then
            record_child_exit backend "${BACKEND_PID}" "${status}"
        elif [[ "${exited_pid}" == "${FRONTEND_PID}" ]]; then
            record_child_exit frontend "${FRONTEND_PID}" "${status}"
        else
            log "a child process exited (status=${status}); process identity unavailable on this Bash version"
        fi
        warn "backend or frontend exited; stopping the remaining process"
    else
        wait "${BACKEND_PID}"
        status="$?"
        record_child_exit backend "${BACKEND_PID}" "${status}"
    fi
    set -e
    return "${status}"
}

main() {
    parse_arguments "$@"
    require_command setsid
    ensure_backend_address_available
    prepare_local_directories
    build_or_copy_backend

    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP

    log "local run starting (pid=$$, version=${VERSION})"

    ensure_backend_address_available
    start_backend "${BACKEND_BINARY}"
    wait_for_backend
    start_frontend_if_available

    log "local data: ${DATA_DIR}"
    log "run log: ${RUN_LOG}"
    if [[ -n "${FRONTEND_PID}" ]]; then
        log "backend and frontend are running; press Ctrl+C to stop both"
    else
        log "backend is running; press Ctrl+C to stop"
    fi
    wait_for_children
}

main "$@"
