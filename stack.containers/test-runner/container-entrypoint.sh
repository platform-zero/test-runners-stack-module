#!/bin/bash

set -euo pipefail

TEST_USER="pwuser"
TEST_USER_HOME="/home/${TEST_USER}"
PLAYWRIGHT_DIR="/app/playwright-tests"
RESULTS_DIR="/app/test-results"
PLAYWRIGHT_RESULTS_DIR="${RESULTS_DIR}/playwright"
DEFAULT_CADDY_CA_PATH="/ca/caddy-ca.crt"
CADDY_CA_ALIAS="caddy-local-root"
CADDY_CA_TARGET="/usr/local/share/ca-certificates/${CADDY_CA_ALIAS}.crt"
NSSDB_DIR="${TEST_USER_HOME}/.pki/nssdb"

log() {
    printf '[test-runner] %s\n' "$*"
}

prepare_results_dir() {
    mkdir -p "$RESULTS_DIR"
    chown -R "${TEST_USER}:${TEST_USER}" "$RESULTS_DIR"
}

copy_tree() {
    local source_dir="$1"
    local target_dir="$2"

    rm -rf "$target_dir"
    mkdir -p "$(dirname "$target_dir")"
    cp -a "$source_dir" "$target_dir"
}

bootstrap_caddy_ca() {
    local source_cert="${CADDY_CA_PATH:-$DEFAULT_CADDY_CA_PATH}"
    local _
    local max_attempts="${CADDY_CA_BOOTSTRAP_ATTEMPTS:-20}"
    local sleep_seconds="${CADDY_CA_BOOTSTRAP_SLEEP_SECONDS:-1}"

    for _ in $(seq 1 "$max_attempts"); do
        [ -s "$source_cert" ] && break
        sleep "$sleep_seconds"
    done
    if [ ! -s "$source_cert" ]; then
        log "Caddy CA is unavailable at $source_cert; continuing without bootstrap"
        return 0
    fi

    install -m 0644 "$source_cert" "$CADDY_CA_TARGET"

    update-ca-certificates >/dev/null 2>&1 || true
    bootstrap_nss_caddy_ca || true

    if command -v keytool >/dev/null 2>&1; then
        if ! keytool -list -cacerts -storepass changeit -alias "$CADDY_CA_ALIAS" >/dev/null 2>&1; then
            keytool -importcert -noprompt -trustcacerts \
                -alias "$CADDY_CA_ALIAS" \
                -file "$CADDY_CA_TARGET" \
                -cacerts \
                -storepass changeit >/dev/null 2>&1 || true
        fi
    fi
}

bootstrap_nss_caddy_ca() {
    if ! command -v certutil >/dev/null 2>&1; then
        log "certutil is unavailable; skipping Chromium NSS trust bootstrap"
        return 0
    fi

    mkdir -p "$NSSDB_DIR"
    chown -R "${TEST_USER}:${TEST_USER}" "$(dirname "$NSSDB_DIR")"

    if ! gosu "$TEST_USER" certutil -d "sql:${NSSDB_DIR}" -L >/dev/null 2>&1; then
        gosu "$TEST_USER" certutil -d "sql:${NSSDB_DIR}" -N --empty-password >/dev/null 2>&1
    fi

    gosu "$TEST_USER" certutil -d "sql:${NSSDB_DIR}" -D -n "$CADDY_CA_ALIAS" >/dev/null 2>&1 || true
    gosu "$TEST_USER" certutil -d "sql:${NSSDB_DIR}" -A -t "C,," -n "$CADDY_CA_ALIAS" -i "$CADDY_CA_TARGET" >/dev/null 2>&1
}

run_as_test_user() {
    if [ -f "$CADDY_CA_TARGET" ]; then
        gosu "$TEST_USER" env \
            HOME="$TEST_USER_HOME" \
            USER="$TEST_USER" \
            LOGNAME="$TEST_USER" \
            NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$CADDY_CA_TARGET}" \
            SSL_CERT_FILE="${SSL_CERT_FILE:-$CADDY_CA_TARGET}" \
            REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$CADDY_CA_TARGET}" \
            "$@"
        return
    fi

    gosu "$TEST_USER" env \
        HOME="$TEST_USER_HOME" \
        USER="$TEST_USER" \
        LOGNAME="$TEST_USER" \
        "$@"
}

exec_as_test_user() {
    if [ -f "$CADDY_CA_TARGET" ]; then
        exec gosu "$TEST_USER" env \
            HOME="$TEST_USER_HOME" \
            USER="$TEST_USER" \
            LOGNAME="$TEST_USER" \
            NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$CADDY_CA_TARGET}" \
            SSL_CERT_FILE="${SSL_CERT_FILE:-$CADDY_CA_TARGET}" \
            REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$CADDY_CA_TARGET}" \
            "$@"
    fi

    exec gosu "$TEST_USER" env \
        HOME="$TEST_USER_HOME" \
        USER="$TEST_USER" \
        LOGNAME="$TEST_USER" \
        "$@"
}

clear_playwright_outputs() {
    rm -rf "$PLAYWRIGHT_DIR/playwright-report" "$PLAYWRIGHT_DIR/test-results"
    rm -rf "$RESULTS_DIR/screenshots"
}

sync_playwright_artifacts() {
    mkdir -p "$PLAYWRIGHT_RESULTS_DIR"

    if [ -d "$PLAYWRIGHT_DIR/playwright-report" ]; then
        copy_tree "$PLAYWRIGHT_DIR/playwright-report" "$PLAYWRIGHT_RESULTS_DIR/report"
    fi

    if [ -d "$PLAYWRIGHT_DIR/test-results" ]; then
        copy_tree "$PLAYWRIGHT_DIR/test-results" "$PLAYWRIGHT_RESULTS_DIR/test-results"
    fi

    if [ -d "$RESULTS_DIR/screenshots" ]; then
        copy_tree "$RESULTS_DIR/screenshots" "$PLAYWRIGHT_RESULTS_DIR/screenshots"
    fi

    chown -R "${TEST_USER}:${TEST_USER}" "$PLAYWRIGHT_RESULTS_DIR"
}

restore_playwright_artifacts() {
    if [ -d "$PLAYWRIGHT_RESULTS_DIR/report" ]; then
        copy_tree "$PLAYWRIGHT_RESULTS_DIR/report" "$PLAYWRIGHT_DIR/playwright-report"
        chown -R "${TEST_USER}:${TEST_USER}" "$PLAYWRIGHT_DIR/playwright-report"
    fi

    if [ -d "$PLAYWRIGHT_RESULTS_DIR/test-results" ]; then
        copy_tree "$PLAYWRIGHT_RESULTS_DIR/test-results" "$PLAYWRIGHT_DIR/test-results"
        chown -R "${TEST_USER}:${TEST_USER}" "$PLAYWRIGHT_DIR/test-results"
    fi

    if [ -d "$PLAYWRIGHT_RESULTS_DIR/screenshots" ]; then
        copy_tree "$PLAYWRIGHT_RESULTS_DIR/screenshots" "$RESULTS_DIR/screenshots"
        chown -R "${TEST_USER}:${TEST_USER}" "$RESULTS_DIR/screenshots"
    fi
}

run_playwright_npm() {
    local exit_code=0

    clear_playwright_outputs
    if run_as_test_user npm run --prefix "$PLAYWRIGHT_DIR" "$@"; then
        exit_code=0
    else
        exit_code=$?
    fi

    sync_playwright_artifacts
    return "$exit_code"
}

record_playwright_suite_artifacts() {
    local suite_name="$1"
    local suite_status="$2"
    local suite_root="${PLAYWRIGHT_RESULTS_DIR}/suites/${suite_name}"

    mkdir -p "$suite_root"
    printf '%s\n' "$suite_status" > "$suite_root/status.txt"

    if [ -d "$PLAYWRIGHT_DIR/playwright-report" ]; then
        copy_tree "$PLAYWRIGHT_DIR/playwright-report" "$suite_root/report"
    fi

    if [ -d "$PLAYWRIGHT_DIR/test-results" ]; then
        copy_tree "$PLAYWRIGHT_DIR/test-results" "$suite_root/test-results"
    fi

    if [ -d "$RESULTS_DIR/screenshots" ]; then
        copy_tree "$RESULTS_DIR/screenshots" "$suite_root/screenshots"
    fi

    chown -R "${TEST_USER}:${TEST_USER}" "$suite_root"
}

run_playwright_e2e_all() {
    local failure_count=0
    local suite_name npm_script exit_code summary_file

    mkdir -p "$PLAYWRIGHT_RESULTS_DIR/suites"
    rm -rf "$PLAYWRIGHT_RESULTS_DIR/suites"/*
    summary_file="$PLAYWRIGHT_RESULTS_DIR/e2e-all-summary.txt"
    : > "$summary_file"

    while IFS='|' read -r suite_name npm_script; do
        [ -n "$suite_name" ] || continue

        clear_playwright_outputs
        if run_as_test_user npm run --prefix "$PLAYWRIGHT_DIR" "$npm_script"; then
            exit_code=0
        else
            exit_code=$?
            failure_count=$((failure_count + 1))
        fi

        sync_playwright_artifacts
        record_playwright_suite_artifacts "$suite_name" "$exit_code"
        printf '%s\t%s\t%s\n' "$suite_name" "$npm_script" "$exit_code" >> "$summary_file"
    done <<'EOF_SUITES'
boundary|test:e2e:boundary
app-smoke|test:e2e:app-smoke
sso|test:e2e:sso
mobile|test:e2e:mobile
workflow|test:e2e:workflow
visual|test:e2e:visual
EOF_SUITES

    chown "${TEST_USER}:${TEST_USER}" "$summary_file"
    [ "$failure_count" -eq 0 ]
}

print_usage() {
    cat <<'USAGE'
Usage: /container-entrypoint.sh [COMMAND] [ARGS]

Commands:
  suite [name]         Run a Kotlin suite through test-runner.jar
  suite-list [name]    List Kotlin managed test ids for a suite
  suite-plan [name]    Print Kotlin managed test plan for a suite
  suite-test <id> [suite] Run one Kotlin managed test id
  ts                   Run all TypeScript tests
  ts-unit              Run Jest unit tests
  ts-unit-one <path>   Run one Jest file
  ts-unit-name <pat>   Run one Jest test by name
  ts-e2e               Run Playwright E2E tests
  ts-e2e-route         Run Playwright route-contract tests
  ts-boundary          Run Playwright anonymous boundary tests
  ts-app-smoke         Run Playwright isolated-user app smoke tests
  ts-sso               Run Playwright shared-user SSO smoke tests
  ts-mobile-smoke      Run Playwright mobile authenticated smoke tests
  ts-mobile-auth       Run Playwright mobile auth/cookie regression tests
  ts-mobile            Run all Playwright mobile suites
  ts-e2e-smoke         Alias for ts-app-smoke
  ts-e2e-deep          Run Playwright deep browser flows
  ts-workflow          Alias for ts-e2e-deep
  ts-e2e-visual        Run Playwright visual snapshot suite
  ts-e2e-all           Run boundary, app-smoke, SSO, workflow, and visual suites (non fail-fast)
  ts-e2e-one <path>    Run one Playwright file
  ts-e2e-name <pat>    Run one Playwright test by name
  ts-ui                Run Playwright UI mode
  ts-headed            Run Playwright headed mode
  ts-debug             Run Playwright debug mode
  ts-report            Serve the latest Playwright report
  shell [cmd...]       Open a shell or run a command as the test user
USAGE
}

prepare_results_dir
bootstrap_caddy_ca

case "${1:-suite}" in
    suite)
        suite_name="${2:-${TEST_SUITE_NAME:-stack-contract}}"
        log "Running suite '${suite_name}'"
        exec java -jar /app/test-runner.jar --env container --suite "$suite_name"
        ;;
    suite-list)
        suite_name="${2:-${TEST_SUITE_NAME:-stack-contract}}"
        log "Listing suite '${suite_name}'"
        exec java -jar /app/test-runner.jar --env container --suite "$suite_name" --list-tests
        ;;
    suite-plan)
        suite_name="${2:-${TEST_SUITE_NAME:-stack-contract}}"
        log "Planning suite '${suite_name}'"
        exec java -jar /app/test-runner.jar --env container --suite "$suite_name" --plan
        ;;
    suite-test)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 suite-test <test-id> [suite]" >&2
            exit 1
        fi
        suite_name="${3:-${TEST_SUITE_NAME:-stack-contract}}"
        log "Running Kotlin managed test '${2}' from suite '${suite_name}'"
        exec java -jar /app/test-runner.jar --env container --suite "$suite_name" --test-id "$2"
        ;;
    ts)
        log "Running all TypeScript tests"
        run_playwright_npm test
        ;;
    ts-unit)
        log "Running Jest unit tests"
        run_playwright_npm test:unit
        ;;
    ts-unit-one)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 ts-unit-one <path>" >&2
            exit 1
        fi
        log "Running Jest test file '${2}'"
        run_playwright_npm test:unit:one -- "$2"
        ;;
    ts-unit-name)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 ts-unit-name <pattern>" >&2
            exit 1
        fi
        log "Running Jest tests matching '${2}'"
        run_playwright_npm test:unit:name -- "$2"
        ;;
    ts-e2e)
        log "Running Playwright E2E tests"
        run_playwright_npm test:e2e
        ;;
    ts-e2e-route)
        log "Running Playwright route-contract tests"
        run_playwright_npm test:e2e:route
        ;;
    ts-boundary)
        log "Running Playwright anonymous boundary tests"
        run_playwright_npm test:e2e:boundary
        ;;
    ts-app-smoke)
        log "Running Playwright isolated-user app smoke tests"
        run_playwright_npm test:e2e:app-smoke
        ;;
    ts-sso)
        log "Running Playwright shared-user SSO smoke tests"
        run_playwright_npm test:e2e:sso
        ;;
    ts-mobile-smoke)
        log "Running Playwright mobile authenticated smoke tests"
        run_playwright_npm test:e2e:mobile-smoke
        ;;
    ts-mobile-auth)
        log "Running Playwright mobile auth/cookie regression tests"
        run_playwright_npm test:e2e:mobile-auth
        ;;
    ts-mobile)
        log "Running Playwright mobile suites"
        run_playwright_npm test:e2e:mobile
        ;;
    ts-e2e-smoke)
        log "Running Playwright isolated-user app smoke tests"
        run_playwright_npm test:e2e:app-smoke
        ;;
    ts-e2e-deep)
        log "Running Playwright deep browser flows"
        run_playwright_npm test:e2e:deep
        ;;
    ts-workflow)
        log "Running Playwright workflow browser flows"
        run_playwright_npm test:e2e:workflow
        ;;
    ts-e2e-visual)
        log "Running Playwright visual snapshot suite"
        run_playwright_npm test:e2e:visual
        ;;
    ts-e2e-all)
        log "Running all Playwright suites (non fail-fast)"
        run_playwright_e2e_all
        ;;
    ts-e2e-one)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 ts-e2e-one <path>" >&2
            exit 1
        fi
        log "Running Playwright test file '${2}'"
        run_playwright_npm test:e2e:one -- "$2"
        ;;
    ts-e2e-name)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 ts-e2e-name <pattern>" >&2
            exit 1
        fi
        log "Running Playwright tests matching '${2}'"
        run_playwright_npm test:e2e:one -- --grep "$2"
        ;;
    ts-ui)
        log "Running Playwright UI mode"
        exec_as_test_user npm run --prefix "$PLAYWRIGHT_DIR" test:ui
        ;;
    ts-headed)
        log "Running Playwright headed mode"
        run_playwright_npm test:headed
        ;;
    ts-debug)
        log "Running Playwright debug mode"
        run_playwright_npm test:debug
        ;;
    ts-report)
        log "Serving the latest Playwright report"
        restore_playwright_artifacts
        exec_as_test_user npm run --prefix "$PLAYWRIGHT_DIR" test:report
        ;;
    shell)
        shift || true
        if [ "$#" -eq 0 ]; then
            exec_as_test_user bash
        fi
        exec_as_test_user "$@"
        ;;
    help|--help|-h)
        print_usage
        ;;
    *)
        print_usage >&2
        exit 1
        ;;
esac
