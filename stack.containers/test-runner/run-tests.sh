#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR_DEFAULT=""
if [ -f "$SCRIPT_DIR/bundle.json" ] && [ -d "$SCRIPT_DIR/runtime" ]; then
    PROJECT_ROOT="$SCRIPT_DIR"
    DIST_DIR_DEFAULT="$PROJECT_ROOT"
elif [ -f "$SCRIPT_DIR/bundle.json" ] && [ -d "$SCRIPT_DIR/quadlet" ]; then
    PROJECT_ROOT="$SCRIPT_DIR"
    DIST_DIR_DEFAULT="$PROJECT_ROOT"
elif [ -f "$SCRIPT_DIR/../../bundle.json" ] && [ -d "$SCRIPT_DIR/../../quadlet" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    DIST_DIR_DEFAULT="$PROJECT_ROOT"
elif [ -f "$SCRIPT_DIR/runtime-contract.yml" ] && [ -d "$SCRIPT_DIR/runtime" ]; then
    PROJECT_ROOT="$SCRIPT_DIR"
    DIST_DIR_DEFAULT="$PROJECT_ROOT"
elif [ -f "$SCRIPT_DIR/runtime-contract.yml" ] && [ -f "$SCRIPT_DIR/runtime.contract/test-runners.yml" ]; then
    PROJECT_ROOT="$SCRIPT_DIR"
    DIST_DIR_DEFAULT="$PROJECT_ROOT"
elif [ -f "$SCRIPT_DIR/../../runtime-contract.yml" ] && [ -f "$SCRIPT_DIR/../../runtime.contract/test-runners.yml" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    DIST_DIR_DEFAULT="$PROJECT_ROOT"
elif [ -d "$SCRIPT_DIR/../global.settings" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    DIST_DIR_DEFAULT="$PROJECT_ROOT/dist"
elif [ -d "$SCRIPT_DIR/../../global.settings" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    DIST_DIR_DEFAULT="$PROJECT_ROOT/dist"
else
    echo "Error: could not locate the repository root" >&2
    exit 1
fi

DIST_DIR="${DIST_DIR:-$DIST_DIR_DEFAULT}"
BUNDLE_METADATA_FILE="${BUNDLE_METADATA_FILE_PATH:-$DIST_DIR/bundle.json}"
PRIMARY_RUNTIME_CONTRACT_FILE="${RUNTIME_CONTRACT_FILE_PATH:-$DIST_DIR/runtime-contract.yml}"
TEST_RUNNERS_RUNTIME_CONTRACT_FILE="${TEST_RUNNERS_RUNTIME_CONTRACT_FILE_PATH:-$DIST_DIR/runtime.contract/test-runners.yml}"
TEST_RUNNER_SERVICE="test-runner"
TEST_RUNNER_MANAGED_SERVICE="${TEST_RUNNER_MANAGED_SERVICE:-test-runner-managed}"
TEST_RUNNER_IMAGE="${TEST_RUNNER_IMAGE:-stack/test-runner:local-build}"
TEST_RUNNER_KEEP_FAILED_CONTAINER="${TEST_RUNNER_KEEP_FAILED_CONTAINER:-0}"
DEFAULT_KT_SUITE="${DEFAULT_KT_SUITE:-stack-contract}"
DEFAULT_RUNTIME_PROJECT_NAME="${DEFAULT_RUNTIME_PROJECT_NAME:-webservices}"
TEST_RESULTS_HOST_DIR_OVERRIDE="${TEST_RESULTS_HOST_DIR:-}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$DEFAULT_RUNTIME_PROJECT_NAME}"
TEST_RUNNER_CONTAINER_CLI="${TEST_RUNNER_CONTAINER_CLI:-podman}"
if [ "$TEST_RUNNER_CONTAINER_CLI" = "podman" ] && [ -z "${CONTAINER_HOST:-}" ]; then
    export CONTAINER_HOST="unix:///run/podman/podman.sock"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

source_unit_available() {
    [ -x "$PROJECT_ROOT/gradlew" ] || return 1
    git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

default_runtime_env_file() {
    local dist_parent=""
    dist_parent="$(dirname "$DIST_DIR")"

    if [ "$(basename "$DIST_DIR")" = "build" ] && [ -f "$dist_parent/runtime/stack.env" ]; then
        printf '%s\n' "$dist_parent/runtime/stack.env"
        return 0
    fi

    printf '%s\n' "$DIST_DIR/runtime/stack.env"
}

resolve_runtime_project_dir() {
    local dist_parent=""
    dist_parent="$(dirname "$DIST_DIR")"

    if [ "$(basename "$DIST_DIR")" = "build" ] && [ -d "$dist_parent/runtime" ]; then
        printf '%s\n' "$dist_parent"
        return 0
    fi

    printf '%s\n' "$DIST_DIR"
}

RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE_PATH:-$(default_runtime_env_file)}"
RUNTIME_PROJECT_DIR="${RUNTIME_PROJECT_DIR:-$(resolve_runtime_project_dir)}"

print_header() {
    local results_root
    results_root="$(resolve_test_results_host_dir)"
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Web Services Test Runner                                                ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Artifacts:${NC}"
    echo "  Runtime project: $COMPOSE_PROJECT_NAME"
    echo "  Project dir:    $RUNTIME_PROJECT_DIR"
    echo "  Bundle metadata: $BUNDLE_METADATA_FILE"
    echo "  Runtime contract: $PRIMARY_RUNTIME_CONTRACT_FILE"
    echo "  Test override:   $TEST_RUNNERS_RUNTIME_CONTRACT_FILE"
    echo "  Runtime env:   $RUNTIME_ENV_FILE"
    echo "  Results root:  $results_root"
    echo ""
}

print_usage() {
    print_header
    echo "Usage: $0 [COMMAND] [ARGS]"
    echo ""
    echo -e "${GREEN}Kotlin:${NC}"
    echo "  kt [suite]        Run the repo-owned Kotlin integration suite (default: $DEFAULT_KT_SUITE)"
    echo "  run [suite]       Alias for kt"
    echo "  kt-list           Print the available Kotlin suites"
    echo "  kt-tests [suite]  Print granular Kotlin managed test ids"
    echo "  kt-plan [suite]   Print granular Kotlin managed test plan"
    echo "  kt-one <id> [suite] Run one granular Kotlin managed test id"
    echo "  kt-core           Run core platform contract checks"
    echo "  kt-auth           Run authentication and protected-operation checks"
    echo "  kt-apps           Run application-surface contract checks"
    echo "  kt-contract       Run the default blocking platform contract suite"
    echo "  kt-live-ingestion Run live ingestion, search corpus, and publication checks"
    echo "  kt-recovery       Run disposable testdev recovery drills"
    echo "  kt-full           Run the full stack suite including live ingestion"
    echo -e "${GREEN}TypeScript / Playwright:${NC}"
    echo "  ts                Run all TypeScript tests"
    echo "  ts-unit           Run Jest unit tests"
    echo "  ts-unit-one <p>   Run one Jest file"
    echo "  ts-unit-name <p>  Run Jest tests matching a name"
    echo "  ts-e2e            Run Playwright E2E tests"
    echo "  ts-e2e-route      Run Playwright route-contract tests"
    echo "  ts-boundary       Run Playwright anonymous boundary tests"
    echo "  ts-app-smoke      Run Playwright isolated-user app smoke tests"
    echo "  ts-sso            Run Playwright shared-user SSO smoke tests"
    echo "  ts-e2e-smoke      Alias for ts-app-smoke"
    echo "  ts-e2e-deep       Run Playwright deep browser flows"
    echo "  ts-workflow       Alias for ts-e2e-deep"
    echo "  ts-e2e-visual     Run Playwright visual snapshot suite"
    echo "  ts-e2e-all        Run boundary, app-smoke, SSO, workflow, and visual suites (non fail-fast)"
    echo "  ts-e2e-one <p>    Run one Playwright spec"
    echo "  ts-e2e-name <p>   Run Playwright tests matching a name"
    echo "  ts-ui             Run Playwright in UI mode"
    echo "  ts-headed         Run Playwright headed mode"
    echo "  ts-debug          Run Playwright debug mode"
    echo "  ts-report         Show the persisted Playwright report"
    echo ""
    echo -e "${GREEN}Meta:${NC}"
    echo "  list              Print available groups and granular Kotlin ids"
    echo "  plan [target]     Print the resolved command plan"
    echo "  run-target <target> Run a registry target or group"
    echo "  gradle-one <module|task> [pattern] Run one Gradle test task, optionally with --tests"
    echo "  changed           Print a heuristic plan for changed files"
    echo "  slowest [n]       Show slowest Kotlin managed tests from latest logs"
    echo "  failed            Show latest failed Kotlin managed tests"
    echo "  source-unit       Run source-local TypeScript compile and Gradle tests"
    echo "  all               Run every registered test/check"
    echo ""
    echo -e "${GREEN}Debug:${NC}"
    echo "  shell [cmd...]    Open a shell in the test-runner container"
    echo ""
}

container_cli() {
    printf '%s\n' "$TEST_RUNNER_CONTAINER_CLI"
}

ensure_runtime_contract_artifacts() {
    if [ ! -f "$BUNDLE_METADATA_FILE" ] && [ ! -f "$PRIMARY_RUNTIME_CONTRACT_FILE" ]; then
        echo -e "${RED}Error:${NC} Bundle metadata not found: $BUNDLE_METADATA_FILE" >&2
        echo "Generate a Podman bundle first so bundle.json and quadlet outputs are present." >&2
        exit 1
    fi

    if [ ! -f "$PRIMARY_RUNTIME_CONTRACT_FILE" ]; then
        echo -e "${RED}Error:${NC} Runtime contract artifact not found: $PRIMARY_RUNTIME_CONTRACT_FILE" >&2
        echo "Refresh the bundled runtime contracts so the managed test-runner can launch its compatibility overlay." >&2
        exit 1
    fi

    if [ ! -f "$TEST_RUNNERS_RUNTIME_CONTRACT_FILE" ]; then
        echo -e "${RED}Error:${NC} Test runner override not found: $TEST_RUNNERS_RUNTIME_CONTRACT_FILE" >&2
        echo "Refresh the bundled test-runner compatibility overlay." >&2
        exit 1
    fi

    if [ ! -f "$RUNTIME_ENV_FILE" ]; then
        echo -e "${RED}Error:${NC} Runtime env file not found: $RUNTIME_ENV_FILE" >&2
        echo "Deploy the bundle first so ./runtime/stack.env is rendered just in time via ./deploy.sh." >&2
        exit 1
    fi
}

resolve_workspace_mount_source() {
    local workspace_root="${1:-$DIST_DIR}"
    local container_id="${HOSTNAME:-}"
    local source=""

    [ -n "$container_id" ] || return 1
    command -v "$(container_cli)" >/dev/null 2>&1 || return 1

    source="$(
        "$(container_cli)" inspect "$container_id" \
            --format "{{range .Mounts}}{{if eq .Destination \"$workspace_root\"}}{{println .Source}}{{end}}{{end}}" \
            2>/dev/null | head -n 1
    )"
    [ -n "$source" ] || return 1
    printf '%s\n' "$source"
}

default_test_results_sibling_dir() {
    local base_dir="$1"
    local base_parent base_name

    base_parent="$(dirname "$base_dir")"
    base_name="$(basename "$base_dir")"
    printf '%s/%s-test-results\n' "$base_parent" "$base_name"
}

resolve_test_results_base_dir() {
    local dist_parent=""
    dist_parent="$(dirname "$DIST_DIR")"

    if [ "$(basename "$DIST_DIR")" = "build" ] && [ -d "$dist_parent/runtime" ]; then
        printf '%s\n' "$dist_parent"
        return 0
    fi

    if [ "$(basename "$DIST_DIR")" = "dist" ]; then
        printf '%s\n' "$dist_parent"
        return 0
    fi

    local mount_source
    if mount_source="$(resolve_workspace_mount_source "$DIST_DIR")"; then
        if [ "$(basename "$DIST_DIR")" = "build" ] && [ -d "$(dirname "$mount_source")/runtime" ]; then
            printf '%s\n' "$(dirname "$mount_source")"
        elif [ "$(basename "$DIST_DIR")" = "dist" ]; then
            printf '%s\n' "$(dirname "$mount_source")"
        else
            printf '%s\n' "$mount_source"
        fi
        return 0
    fi

    printf '%s\n' "$DIST_DIR"
}

resolve_test_results_host_dir() {
    if [ -n "$TEST_RESULTS_HOST_DIR_OVERRIDE" ]; then
        printf '%s\n' "$TEST_RESULTS_HOST_DIR_OVERRIDE"
        return 0
    fi

    default_test_results_sibling_dir "$(resolve_test_results_base_dir)"
}

resolve_test_runner_runtime_host_dir() {
    local runtime_dir
    runtime_dir="$(dirname "$RUNTIME_ENV_FILE")"
    (
        cd "$runtime_dir"
        pwd -P
    )
}

resolve_test_runner_components_lock_host_file() {
    local explicit="${TEST_RUNNER_COMPONENTS_LOCK_HOST_FILE_OVERRIDE:-${TEST_RUNNER_COMPONENTS_LOCK_HOST_FILE:-}}"
    if [ -n "$explicit" ]; then
        printf '%s\n' "$explicit"
        return 0
    fi

    local candidates=(
        "$DIST_DIR/site/components.lock.json"
        "$(dirname "$DIST_DIR")/build/site/components.lock.json"
        "$RUNTIME_PROJECT_DIR/build/site/components.lock.json"
        "$RUNTIME_PROJECT_DIR/site/components.lock.json"
    )

    local candidate
    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate" ]; then
            (
                cd "$(dirname "$candidate")"
                printf '%s/%s\n' "$(pwd -P)" "$(basename "$candidate")"
            )
            return 0
        fi
    done

    printf '%s\n' "/dev/null"
}

resolve_test_runner_systemd_runtime_host_dir() {
    local runtime_dir="${TEST_RUNNER_HOST_XDG_RUNTIME_DIR_OVERRIDE:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}}"

    if [ "${TEST_RUNNER_REQUIRE_SYSTEMD_RUNTIME:-1}" = "0" ]; then
        mkdir -p "$runtime_dir"
        printf '%s\n' "$runtime_dir"
        return 0
    fi

    if [ ! -S "$runtime_dir/bus" ]; then
        echo -e "${RED}Error:${NC} Host user systemd bus is unavailable at $runtime_dir/bus" >&2
        echo "The managed test-runner now controls runtime-managed services through systemd --user." >&2
        echo "Ensure lingering is enabled and the user manager is running before invoking run-tests.sh." >&2
        exit 1
    fi

    printf '%s\n' "$runtime_dir"
}

container_contract() {
    "$(container_cli)" compose "$@"
}

runtime_contract_runner() {
    ensure_runtime_contract_artifacts
    local components_lock_file
    components_lock_file="$(resolve_test_runner_components_lock_host_file)"
    TEST_RESULTS_HOST_DIR="$(resolve_test_results_host_dir)" \
    TEST_RUNNER_RUNTIME_HOST_DIR="$(resolve_test_runner_runtime_host_dir)" \
    TEST_RUNNER_COMPONENTS_LOCK_HOST_FILE="$components_lock_file" \
    TEST_RUNNER_HOST_XDG_RUNTIME_DIR="$(resolve_test_runner_systemd_runtime_host_dir)" \
    container_contract \
        --env-file "$RUNTIME_ENV_FILE" \
        --project-directory "$RUNTIME_PROJECT_DIR" \
        -f "$PRIMARY_RUNTIME_CONTRACT_FILE" \
        -f "$TEST_RUNNERS_RUNTIME_CONTRACT_FILE" \
        "$@"
}

build_runner_image() {
    echo "Building managed test-runner image: $TEST_RUNNER_IMAGE" >&2
    runtime_contract_runner build "$TEST_RUNNER_SERVICE"
}

managed_runner_container_name() {
    printf '%s-%s-1\n' "$COMPOSE_PROJECT_NAME" "$TEST_RUNNER_MANAGED_SERVICE"
}

purge_managed_runner_container() {
    local container_name
    container_name="$(managed_runner_container_name)"
    if "$(container_cli)" inspect "$container_name" >/dev/null 2>&1; then
        echo "Removing stale managed runner container: $container_name" >&2
        "$(container_cli)" rm -f "$container_name" >/dev/null 2>&1 || true
    fi
}

print_managed_runner_failure_diagnostics() {
    local container_name exit_status inspect_output state_status state_error state_oom state_finished
    exit_status="$1"
    container_name="$(managed_runner_container_name)"

    if ! inspect_output="$(
        "$(container_cli)" inspect "$container_name" \
            --format '{{.State.Status}}|{{.State.Error}}|{{.State.OOMKilled}}|{{.State.FinishedAt}}' \
            2>/dev/null
    )"; then
        return 0
    fi

    state_status="$(printf '%s' "$inspect_output" | cut -d'|' -f1)"
    state_error="$(printf '%s' "$inspect_output" | cut -d'|' -f2)"
    state_oom="$(printf '%s' "$inspect_output" | cut -d'|' -f3)"
    state_finished="$(printf '%s' "$inspect_output" | cut -d'|' -f4)"

    echo -e "${YELLOW}Managed runner failure diagnostics:${NC}" >&2
    echo "  container: $container_name" >&2
    echo "  exit status: $exit_status" >&2
    echo "  container state: $state_status" >&2
    echo "  oom_killed: $state_oom" >&2
    [ -n "$state_error" ] && [ "$state_error" != "<nil>" ] && echo "  state error: $state_error" >&2
    [ -n "$state_finished" ] && echo "  finished at: $state_finished" >&2

    if [ "$exit_status" -eq 137 ]; then
        if [ "$state_oom" = "true" ]; then
            echo "  likely cause: container was OOM-killed by the kernel or runtime memory pressure" >&2
        else
            echo "  likely cause: container received SIGKILL (container stop/kill, host pressure, or external interruption)" >&2
        fi
    fi
}

repair_dir_ownership() {
    local target="$1"
    local uid gid

    uid="$(id -u 2>/dev/null || true)"
    gid="$(id -g 2>/dev/null || true)"
    if [ -z "$uid" ] || [ -z "$gid" ] || ! command -v "$(container_cli)" >/dev/null 2>&1; then
        return 1
    fi

    "$(container_cli)" run --rm -v "$target:/target" alpine sh -lc "chown -R $uid:$gid /target && chmod -R u+rwX /target" >/dev/null 2>&1
}

ensure_writable_dir() {
    local dir="$1"

    if mkdir -p "$dir" 2>/dev/null && [ -d "$dir" ] && [ -w "$dir" ]; then
        return 0
    fi

    chmod u+rwx "$dir" 2>/dev/null || true
    repair_dir_ownership "$dir" || true

    if mkdir -p "$dir" 2>/dev/null && [ -d "$dir" ] && [ -w "$dir" ]; then
        return 0
    fi

    echo -e "${RED}Error:${NC} Unable to prepare writable test results directory: $dir" >&2
    exit 1
}

build_exec_env_args() {
    EXEC_ENV_ARGS=()
    EXEC_ENV_ASSIGNMENTS=()
    local passthrough_vars=(
        TEST_RUNNER_OAUTH_SECRET
        MODEL_CONTEXT_OIDC_CLIENT_ID
        MODEL_CONTEXT_OIDC_CLIENT_SECRET
        MODEL_CONTEXT_OIDC_REDIRECT_URI
        MODEL_CONTEXT_OIDC_SCOPE
        STACK_ADMIN_USER
        STACK_ADMIN_PASSWORD
        STACK_ADMIN_EMAIL
        AIDER_OLLAMA_API_BASE
        AIDER_MODEL
        AIDER_EDIT_FORMAT
        CADDY_CONTAINER
        TESTDEV_SKIP_GPU_INGESTION
    )

    local var_name
    for var_name in "${passthrough_vars[@]}"; do
        if [ -n "${!var_name:-}" ]; then
            EXEC_ENV_ARGS+=("-e" "${var_name}=${!var_name}")
            EXEC_ENV_ASSIGNMENTS+=("${var_name}=${!var_name}")
        fi
    done
}

shell_join_args() {
    local joined=""
    printf -v joined '%q ' "$@"
    joined="${joined% }"
    printf '%s\n' "$joined"
}

runtime_contract_runner_with_env() {
    ensure_runtime_contract_artifacts
    local results_root="$1"
    shift
    local runtime_root
    runtime_root="$(resolve_test_runner_runtime_host_dir)"
    local components_lock_file
    components_lock_file="$(resolve_test_runner_components_lock_host_file)"
    local systemd_runtime_root
    systemd_runtime_root="$(resolve_test_runner_systemd_runtime_host_dir)"
    local env_assignments=()
    while [ "$#" -gt 0 ] && [[ "$1" != "--" ]]; do
        env_assignments+=("$1")
        shift
    done
    if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
        shift
    fi

    env "TEST_RESULTS_HOST_DIR=$results_root" "TEST_RUNNER_RUNTIME_HOST_DIR=$runtime_root" "TEST_RUNNER_COMPONENTS_LOCK_HOST_FILE=$components_lock_file" "TEST_RUNNER_HOST_XDG_RUNTIME_DIR=$systemd_runtime_root" "${env_assignments[@]}" "$(container_cli)" compose \
        --env-file "$RUNTIME_ENV_FILE" \
        --project-directory "$RUNTIME_PROJECT_DIR" \
        -f "$PRIMARY_RUNTIME_CONTRACT_FILE" \
        -f "$TEST_RUNNERS_RUNTIME_CONTRACT_FILE" \
        "$@"
}

print_artifact_paths() {
    local results_root="$1"
    local run_command="${2:-}"
    local latest_suite_dir=""

    echo ""
    echo -e "${BLUE}Artifacts written:${NC}"
    echo "  Results root: $results_root"

    local latest_suite_entries=()
    mapfile -t latest_suite_entries < <(
        find "$results_root" -mindepth 1 -maxdepth 1 -type d -name '20*-stack-*' -printf '%T@ %p\n' 2>/dev/null | sort -nr
    )
    if [ "${#latest_suite_entries[@]}" -gt 0 ]; then
        latest_suite_dir="${latest_suite_entries[0]#* }"
    fi
    if [ -n "$latest_suite_dir" ]; then
        echo "  Latest suite: $latest_suite_dir"
    fi

    if [ -d "$results_root/playwright" ]; then
        echo "  Playwright dir: $results_root/playwright"
        [ -f "$results_root/playwright/report/index.html" ] && echo "  Playwright report: $results_root/playwright/report/index.html"
        [ -d "$results_root/playwright/test-results" ] && echo "  Playwright raw results: $results_root/playwright/test-results"
        [ -d "$results_root/playwright/screenshots" ] && echo "  Playwright screenshots: $results_root/playwright/screenshots"
    elif [[ "$run_command" =~ ^ts ]]; then
        echo -e "  ${YELLOW}Warning:${NC} Playwright artifacts were not found under $results_root/playwright"
    fi
    echo ""
}

run_runner_no_build() {
    local results_root command_line status=0
    results_root="$(resolve_test_results_host_dir)"
    ensure_writable_dir "$results_root"
    build_exec_env_args
    command_line="$(shell_join_args "$@")"
    purge_managed_runner_container

    runtime_contract_runner_with_env "$results_root" "${EXEC_ENV_ASSIGNMENTS[@]}" \
        "TEST_RUNNER_MANAGED_COMMAND_LINE=$command_line" \
        -- \
        rm -fsv "$TEST_RUNNER_MANAGED_SERVICE" >/dev/null 2>&1 || true

    set +e
    runtime_contract_runner_with_env "$results_root" "${EXEC_ENV_ASSIGNMENTS[@]}" \
        "TEST_RUNNER_MANAGED_COMMAND_LINE=$command_line" \
        -- \
        up --force-recreate --no-build --pull never --no-deps --abort-on-container-exit --exit-code-from "$TEST_RUNNER_MANAGED_SERVICE" "$TEST_RUNNER_MANAGED_SERVICE"
    status=$?
    set -e

    if [ "$status" -ne 0 ]; then
        print_managed_runner_failure_diagnostics "$status"
    fi

    if [ "$status" -ne 0 ] && [ "$TEST_RUNNER_KEEP_FAILED_CONTAINER" = "1" ]; then
        echo -e "${YELLOW}Preserving failed managed runner container for inspection (TEST_RUNNER_KEEP_FAILED_CONTAINER=1).${NC}" >&2
        echo "Inspect with: $(container_cli) inspect $(managed_runner_container_name)" >&2
    else
        runtime_contract_runner_with_env "$results_root" "${EXEC_ENV_ASSIGNMENTS[@]}" \
            "TEST_RUNNER_MANAGED_COMMAND_LINE=$command_line" \
            -- \
            rm -fsv "$TEST_RUNNER_MANAGED_SERVICE" >/dev/null 2>&1 || true
        purge_managed_runner_container
    fi

    print_artifact_paths "$results_root" "${1:-}"

    return "$status"
}

run_runner() {
    local results_root
    results_root="$(resolve_test_results_host_dir)"
    ensure_writable_dir "$results_root"
    if [ "${TEST_RUNNER_NO_BUILD:-0}" = "1" ]; then
        run_runner_no_build "$@"
        return
    fi
    build_runner_image
    run_runner_no_build "$@"
}

run_all_tests() {
    local failed=0
    local step_name step_command command_status
    local summary_file results_root
    local -a step_commands=(
        "kt-full|suite stack-full"
        "ts-unit|ts-unit"
        "ts-e2e-all|ts-e2e-all"
    )

    results_root="$(resolve_test_results_host_dir)"
    ensure_writable_dir "$results_root"
    summary_file="$results_root/all-summary.txt"
    : > "$summary_file"

    if source_unit_available; then
        step_commands=("source-unit|source-unit" "${step_commands[@]}")
    fi

    if [ "${TEST_RUNNER_NO_BUILD:-0}" != "1" ]; then
        build_runner_image
    fi

    for step in "${step_commands[@]}"; do
        step_name="${step%%|*}"
        step_command="${step#*|}"
        read -r -a step_args <<< "$step_command"

        echo -e "${BLUE}=== Running $step_name ===${NC}"
        if [ "$step_command" = "source-unit" ]; then
            set +e
            run_source_unit_tests
            command_status=$?
            set -e
        elif run_runner_no_build "${step_args[@]}"; then
            command_status=0
        else
            command_status=$?
        fi

        if [ "$command_status" -eq 0 ]; then
            echo -e "${GREEN}PASS${NC} $step_name"
        else
            failed=$((failed + 1))
            echo -e "${RED}FAIL${NC} $step_name (exit $command_status)"
        fi
        printf '%s\t%s\n' "$step_name" "$command_status" >> "$summary_file"
    done

    echo ""
    echo -e "${BLUE}All-tests summary:${NC} $summary_file"
    if [ "$failed" -ne 0 ]; then
        echo -e "${RED}$failed step(s) failed.${NC}"
        return 1
    fi
    echo -e "${GREEN}All test steps passed.${NC}"
}

run_source_unit_tests() {
    if ! source_unit_available; then
        echo -e "${RED}Error:${NC} source-unit requires a source checkout with ./gradlew at $PROJECT_ROOT" >&2
        return 1
    fi

    local test_dir="$PROJECT_ROOT/stack.containers/test-runner/playwright-tests"
    if [ -f "$test_dir/package.json" ]; then
        if [ ! -d "$test_dir/node_modules" ]; then
            (cd "$test_dir" && npm ci) || return $?
        fi
        (cd "$test_dir" && npm run build) || return $?
    fi

    (cd "$PROJECT_ROOT" && ./gradlew test --no-daemon) || return $?
}

run_gradle_one() {
    if [ ! -x "$PROJECT_ROOT/gradlew" ]; then
        echo -e "${RED}Error:${NC} gradle-one requires a source checkout with ./gradlew at $PROJECT_ROOT" >&2
        return 1
    fi
    local target="${1:-}"
    local pattern="${2:-}"
    if [ -z "$target" ]; then
        echo -e "${RED}Error:${NC} gradle-one requires a module name or Gradle test task" >&2
        return 1
    fi
    local task="$target"
    if [[ "$target" != :* ]]; then
        task=":$target:test"
    fi
    if [ -n "$pattern" ]; then
        (cd "$PROJECT_ROOT" && ./gradlew "$task" --tests "$pattern" --no-daemon)
    else
        (cd "$PROJECT_ROOT" && ./gradlew "$task" --no-daemon)
    fi
}

run_kotlin_metadata() {
    local mode="${1:-}"
    local suite="${2:-kotlin-all}"
    local runner_flag=""
    case "$mode" in
        list) runner_flag="--list-tests" ;;
        plan) runner_flag="--plan" ;;
        *)
            echo -e "${RED}Error:${NC} unknown Kotlin metadata mode: $mode" >&2
            return 1
            ;;
    esac

    if source_unit_available; then
        (cd "$PROJECT_ROOT" && ./gradlew :test-runner:run --args="--suite $suite $runner_flag --env localhost" --no-daemon)
    else
        run_runner "suite-$mode" "$suite"
    fi
}

print_test_plan() {
    local target="${1:-all}"
    case "$target" in
        all)
            cat <<'EOF_PLAN'
Plan: all
Includes every deployment-safe test/check exposed by run-tests.sh:
EOF_PLAN
            local index=1
            if source_unit_available; then
                echo "  $index. source-unit"
                index=$((index + 1))
            fi
            for item in kt-full ts-unit ts-e2e-all; do
                echo "  $index. $item"
                index=$((index + 1))
            done
            ;;
        default)
            echo "Plan: default"
            local index=1
            if source_unit_available; then
                echo "  $index. source-unit"
                index=$((index + 1))
            fi
            cat <<EOF_PLAN
  $index. kt-contract
  $((index + 1)). ts-unit
  $((index + 2)). ts-boundary
  $((index + 3)). ts-app-smoke
  $((index + 4)). ts-sso
EOF_PLAN
            ;;
        kt-*|stack-*)
            echo "Plan: $target"
            case "$target" in
                kt-core) echo "  1. suite stack-core" ;;
                kt-auth) echo "  1. suite stack-auth" ;;
                kt-apps) echo "  1. suite stack-apps" ;;
                kt-contract) echo "  1. suite stack-contract" ;;
                kt-live-ingestion) echo "  1. suite stack-live-ingestion" ;;
                kt-recovery) echo "  1. suite stack-recovery" ;;
                kt-full) echo "  1. suite stack-full" ;;
                *) echo "  1. suite $target" ;;
            esac
            ;;
        *)
            echo "Plan: $target"
            echo "  1. granular or passthrough target"
            ;;
    esac
}

run_registry_target() {
    local target="${1:-}"
    if [ -z "$target" ]; then
        echo -e "${RED}Error:${NC} run-target requires a target" >&2
        return 1
    fi
    shift || true

    case "$target" in
        all) run_all_tests ;;
        default)
            local failed=0 step command_status
            if source_unit_available; then
                if ! run_source_unit_tests; then
                    failed=$((failed + 1))
                fi
            fi
            for step in \
                "suite stack-contract" \
                "ts-unit" \
                "ts-boundary" \
                "ts-app-smoke" \
                "ts-sso"; do
                read -r -a step_args <<< "$step"
                if run_runner "${step_args[@]}"; then
                    command_status=0
                else
                    command_status=$?
                    failed=$((failed + 1))
                    echo -e "${RED}FAIL${NC} $step (exit $command_status)"
                fi
            done
            [ "$failed" -eq 0 ]
            ;;
        source-unit) run_source_unit_tests ;;
        kt-core) run_runner suite stack-core ;;
        kt-auth) run_runner suite stack-auth ;;
        kt-apps) run_runner suite stack-apps ;;
        kt-contract|stack-contract) run_runner suite stack-contract ;;
        kt-live-ingestion|stack-live-ingestion) run_runner suite stack-live-ingestion ;;
        kt-recovery|stack-recovery) run_runner suite stack-recovery ;;
        kt-full|stack-full) run_runner suite stack-full ;;
        ts-unit|ts-boundary|ts-app-smoke|ts-sso|ts-e2e|ts-e2e-route|ts-e2e-deep|ts-workflow|ts-e2e-visual|ts-e2e-all)
            run_runner "$target" "$@"
            ;;
        ts-e2e-smoke) run_runner ts-app-smoke "$@" ;;
        kt:*)
            run_runner suite "${target#kt:}"
            ;;
        ts:*)
            run_runner "ts-${target#ts:}" "$@"
            ;;
        *)
            echo -e "${RED}Error:${NC} unknown registry target: $target" >&2
            return 1
            ;;
    esac
}

print_changed_plan() {
    local files=()
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        mapfile -t files < <(git diff --name-only HEAD --)
    fi
    if [ "${#files[@]}" -eq 0 ]; then
        echo "No changed files relative to HEAD."
        return 0
    fi

    local targets=()
    local file
    for file in "${files[@]}"; do
        case "$file" in
            stack.kotlin/test-runner/*) targets+=("source-unit" "kt-contract") ;;
            stack.kotlin/search-service/*) targets+=("source-unit" "kt-live-ingestion") ;;
            stack.kotlin/*) targets+=("source-unit") ;;
            stack.containers/test-runner/playwright-tests/tests/unit/*) targets+=("ts-unit") ;;
            stack.containers/test-runner/playwright-tests/tests/fast/*) targets+=("ts-boundary" "ts-app-smoke" "ts-sso") ;;
            stack.containers/test-runner/playwright-tests/tests/deep/*) targets+=("ts-e2e-deep") ;;
            stack.containers/test-runner/playwright-tests/tests/visual/*|stack.containers/test-runner/playwright-tests/utils/route-catalog.ts) targets+=("ts-e2e-visual") ;;
            stack.containers/test-runner/*) targets+=("source-unit" "ts-unit") ;;
            runtime.contract/kopia.yml|scripts/testdev/*) targets+=("source-unit" "kt-recovery" "kt-contract") ;;
            runtime.contract/*|stack.config/*|scripts/*) targets+=("source-unit" "kt-contract" "ts-boundary") ;;
            *) targets+=("source-unit") ;;
        esac
    done

    echo "Changed files:"
    printf '  %s\n' "${files[@]}"
    echo ""
    echo "Recommended targets:"
    printf '%s\n' "${targets[@]}" | awk '!seen[$0]++ {print "  " $0}'
}

latest_results_dir() {
    local required_file="${1:-}"
    local root
    root="$(resolve_test_results_host_dir)"
    if [ -n "$required_file" ]; then
        find "$root" -mindepth 1 -maxdepth 1 -type d -name '20*-*' -exec test -f '{}/'"$required_file" \; -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {sub(/^[^ ]+ /, ""); print}'
    else
        find "$root" -mindepth 1 -maxdepth 1 -type d -name '20*-*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {sub(/^[^ ]+ /, ""); print}'
    fi
}

print_slowest_tests() {
    local limit="${1:-20}"
    local dir
    dir="$(latest_results_dir detailed.log)"
    if [ -z "$dir" ] || [ ! -f "$dir/detailed.log" ]; then
        echo "No Kotlin detailed.log found in latest results." >&2
        return 1
    fi
    awk '
      /\[TEST\]/ { name=$0; sub(/^.*\[TEST\] /, "", name); sub(/ \.\.\. *$/, "", name) }
      /OK \([0-9]+ms\)|FAIL \([0-9]+ms\)|ERROR \([0-9]+ms\)|SKIP \([0-9]+ms\)/ {
        if (name != "") {
          ms=$0; sub(/^.*\(/, "", ms); sub(/ms\).*$/, "", ms); print ms "\t" name
        }
      }
    ' "$dir/detailed.log" | sort -nr | head -n "$limit"
}

print_failed_tests() {
    local dir
    dir="$(latest_results_dir failures.log)"
    if [ -z "$dir" ] || [ ! -f "$dir/failures.log" ]; then
        echo "No failures.log found in latest results." >&2
        return 1
    fi
    awk '/^Test: / {sub(/^Test: /, ""); print}' "$dir/failures.log"
}

print_test_catalog() {
    print_test_plan all
    echo ""
    echo "Groups:"
    printf '%s\n' all default
    echo ""
    echo "Targets:"
    printf '%s\n' source-unit kt-core kt-auth kt-apps kt-contract kt-live-ingestion kt-recovery kt-full ts-unit ts-boundary ts-app-smoke ts-sso ts-e2e ts-e2e-deep ts-e2e-visual ts-e2e-all
    echo ""
    echo "Kotlin suites:"
    printf '%s\n' stack-core stack-auth stack-apps stack-contract stack-live-ingestion stack-recovery stack-full kotlin-all
    echo ""
    echo "Granular Kotlin managed tests:"
    run_kotlin_metadata list kotlin-all
}

COMMAND="${1:-kt}"
shift || true

if [[ ! "$COMMAND" =~ ^(kt|run|kt-list|kt-tests|kt-plan|kt-one|kt-core|kt-auth|kt-apps|kt-contract|kt-live-ingestion|kt-recovery|kt-full|ts|ts-unit|ts-unit-one|ts-unit-name|ts-boundary|ts-app-smoke|ts-sso|ts-e2e|ts-e2e-route|ts-e2e-smoke|ts-e2e-deep|ts-workflow|ts-e2e-visual|ts-e2e-all|ts-e2e-one|ts-e2e-name|ts-ui|ts-headed|ts-debug|ts-report|source-unit|gradle-one|list|plan|run-target|changed|slowest|failed|all|shell|--help|-h|help)$ ]]; then
    set -- "$COMMAND" "$@"
    COMMAND="kt"
fi

case "$COMMAND" in
    kt|run)
        run_runner suite "${1:-$DEFAULT_KT_SUITE}"
        ;;
    kt-list)
        printf '%s\n' stack-core stack-auth stack-apps stack-contract stack-live-ingestion stack-recovery stack-full kotlin-all
        ;;
    kt-tests)
        run_kotlin_metadata list "${1:-kotlin-all}"
        ;;
    kt-plan)
        run_kotlin_metadata plan "${1:-kotlin-all}"
        ;;
    kt-one)
        if [ -z "${1:-}" ]; then
            echo -e "${RED}Error:${NC} kt-one requires a granular Kotlin test id" >&2
            exit 1
        fi
        test_id="$1"
        suite_name="${2:-stack-contract}"
        run_runner suite-test "$test_id" "$suite_name"
        ;;
    kt-core)
        run_runner suite stack-core
        ;;
    kt-auth)
        run_runner suite stack-auth
        ;;
    kt-apps)
        run_runner suite stack-apps
        ;;
    kt-contract)
        run_runner suite stack-contract
        ;;
    kt-live-ingestion)
        run_runner suite stack-live-ingestion
        ;;
    kt-recovery)
        run_runner suite stack-recovery
        ;;
    kt-full)
        run_runner suite stack-full
        ;;
    ts)
        run_runner ts "$@"
        ;;
    ts-unit)
        run_runner ts-unit "$@"
        ;;
    ts-unit-one)
        run_runner ts-unit-one "$@"
        ;;
    ts-unit-name)
        run_runner ts-unit-name "$@"
        ;;
    ts-e2e)
        run_runner ts-e2e "$@"
        ;;
    ts-e2e-route)
        run_runner ts-e2e-route "$@"
        ;;
    ts-boundary)
        run_runner ts-boundary "$@"
        ;;
    ts-app-smoke)
        run_runner ts-app-smoke "$@"
        ;;
    ts-sso)
        run_runner ts-sso "$@"
        ;;
    ts-e2e-smoke)
        run_runner ts-app-smoke "$@"
        ;;
    ts-e2e-deep)
        run_runner ts-e2e-deep "$@"
        ;;
    ts-workflow)
        run_runner ts-e2e-deep "$@"
        ;;
    ts-e2e-visual)
        run_runner ts-e2e-visual "$@"
        ;;
    ts-e2e-all)
        run_runner ts-e2e-all "$@"
        ;;
    ts-e2e-one)
        run_runner ts-e2e-one "$@"
        ;;
    ts-e2e-name)
        run_runner ts-e2e-name "$@"
        ;;
    ts-ui)
        run_runner ts-ui "$@"
        ;;
    ts-headed)
        run_runner ts-headed "$@"
        ;;
    ts-debug)
        run_runner ts-debug "$@"
        ;;
    ts-report)
        run_runner ts-report "$@"
        ;;
    source-unit)
        run_source_unit_tests
        ;;
    gradle-one)
        run_gradle_one "$@"
        ;;
    list)
        print_test_catalog
        ;;
    plan)
        print_test_plan "${1:-all}"
        ;;
    run-target)
        run_registry_target "$@"
        ;;
    changed)
        print_changed_plan
        ;;
    slowest)
        print_slowest_tests "${1:-20}"
        ;;
    failed)
        print_failed_tests
        ;;
    all)
        run_all_tests
        ;;
    shell)
        run_runner shell "$@"
        ;;
    --help|-h|help)
        print_usage
        ;;
    *)
        echo -e "${RED}Error:${NC} Unknown command: $COMMAND" >&2
        print_usage >&2
        exit 1
        ;;
esac
