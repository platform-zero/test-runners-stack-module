#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLAYWRIGHT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

project_name="${TEST_RUNNER_COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-webservices}}"

isolated_docker_vm_identity_configured() {
  if [ -n "${ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED:-}" ]; then
    [ "$ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED" = "1" ] || [ "$ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED" = "true" ]
    return $?
  fi

  [ -n "${ISOLATED_DOCKER_VM_SSH_DIR:-}" ] && [ -f "${ISOLATED_DOCKER_VM_SSH_DIR}/id_ed25519" ]
}

detect_optional_capabilities() {
  if isolated_docker_vm_identity_configured; then
    export ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED=1
  else
    export ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED=0
  fi
}

isolated_docker_vm_socket_skip_reason() {
  printf '%s' 'isolated Docker VM socket is not configured'
}

container_name_for_service() {
  local service_name="$1"
  docker ps \
    --filter "label=com.docker.compose.project=${project_name}" \
    --filter "label=com.docker.compose.service=${service_name}" \
    --format '{{.Names}}' \
    | head -n 1
}

require_container_health() {
  local service_name="$1"
  local container_name inspect_output container_status health_status

  container_name="$(container_name_for_service "$service_name")"
  [ -n "$container_name" ] || container_name="$service_name"

  if ! inspect_output="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null)"; then
    printf 'missing:%s\n' "$service_name"
    return 1
  fi

  container_status="$(printf '%s' "$inspect_output" | awk '{print $1}')"
  health_status="$(printf '%s' "$inspect_output" | awk '{print $2}')"

  if [ "$container_status" != "running" ]; then
    printf 'stopped:%s:%s\n' "$service_name" "$container_status"
    return 1
  fi

  if [ "$health_status" != "none" ] && [ "$health_status" != "healthy" ]; then
    printf 'unhealthy:%s:%s\n' "$service_name" "$health_status"
    return 1
  fi

  return 0
}

require_services() {
  local missing_report="" service_name status_line
  for service_name in "$@"; do
    [ -n "$service_name" ] || continue
    if ! status_line="$(require_container_health "$service_name")"; then
      if [ -n "$missing_report" ]; then
        missing_report="${missing_report}"$'\n'
      fi
      missing_report="${missing_report}${status_line}"
    fi
  done

  if [ -n "$missing_report" ]; then
    printf 'Playwright suite preflight failed. Required local containers for this selected suite are missing or unhealthy:\n' >&2
    printf '%s\n' "$missing_report" >&2
    return 1
  fi
}

run_specs() {
  local route_hosts="$1"
  shift
  if [ -n "$route_hosts" ]; then
    PLAYWRIGHT_ROUTE_HOSTS="$route_hosts" npx playwright test "$@"
  else
    npx playwright test "$@"
  fi
}

run_group() {
  local group="$1"
  cd "$PLAYWRIGHT_DIR"
  detect_optional_capabilities

  case "$group" in
    route)
      PW_SKIP_GLOBAL_SETUP=1 run_specs "" tests/fast/route-contract.spec.ts
      ;;
    boundary)
      PW_SKIP_GLOBAL_SETUP=1 run_specs "" tests/fast/route-contract.spec.ts tests/deep/forward-auth/non-browser-api-endpoints.spec.ts
      if [ "$ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED" = "1" ]; then
        require_services workspace-provisioner
        PW_SKIP_GLOBAL_SETUP=1 run_specs "workspaces" tests/fast/workspaces-boundary.spec.ts
      else
        printf 'Skipping boundary:workspaces: %s.\n' "$(isolated_docker_vm_socket_skip_reason)"
      fi
      ;;
    app-smoke)
      require_services caddy keycloak keycloak-auth-gateway
      PW_SKIP_GLOBAL_SETUP=1 run_specs "" tests/fast/app-smoke.spec.ts
      ;;
    sso)
      require_services caddy keycloak keycloak-auth-gateway
      run_specs "" tests/fast/sso-session.spec.ts
      ;;
    deep:alertmanager)
      require_services caddy keycloak keycloak-auth-gateway alertmanager
      run_specs "alerts" tests/deep/forward-auth/alertmanager.spec.ts
      ;;
    deep:bookstack)
      require_services caddy keycloak bookstack
      run_specs "bookstack" tests/deep/oidc/bookstack.spec.ts
      ;;
    deep:element)
      require_services caddy keycloak element synapse matrix-authentication-service livekit matrix-rtc-auth
      run_specs "element" tests/deep/oidc/element.spec.ts tests/deep/oidc/element-call-livekit.spec.ts
      ;;
    deep:forgejo)
      require_services caddy keycloak forgejo
      run_specs "forgejo" tests/deep/oidc/forgejo.spec.ts
      ;;
    deep:grafana)
      require_services caddy keycloak keycloak-auth-gateway grafana loki
      run_specs "grafana" tests/deep/forward-auth/grafana.spec.ts tests/deep/oidc/grafana.spec.ts
      ;;
    deep:homeassistant)
      require_services caddy keycloak keycloak-auth-gateway homeassistant
      run_specs "homeassistant" tests/deep/forward-auth/homeassistant.spec.ts
      ;;
    deep:jellyfin)
      require_services caddy keycloak jellyfin
      run_specs "jellyfin" tests/deep/oidc/jellyfin.spec.ts tests/deep/oidc/jellyfin-external-api.spec.ts
      ;;
    deep:jupyterhub)
      require_services caddy keycloak keycloak-auth-gateway jupyterhub
      run_specs "jupyterhub" tests/deep/forward-auth/jupyterhub.spec.ts
      ;;
    deep:keycloak)
      require_services caddy keycloak keycloak-auth-gateway
      run_specs "keycloak,keycloak-auth,keycloak-whoami" tests/deep/oidc/keycloak.spec.ts
      ;;
    deep:kopia)
      require_services caddy keycloak keycloak-auth-gateway kopia
      run_specs "kopia" tests/deep/forward-auth/kopia.spec.ts
      ;;
    deep:matrix)
      require_services caddy keycloak synapse matrix-authentication-service livekit matrix-rtc-auth
      run_specs "matrix,api.matrix,matrix-rtc" tests/deep/oidc/matrix-authentication-service.spec.ts tests/deep/oidc/matrix-media-integrity.spec.ts
      ;;
    deep:mastodon)
      require_services caddy keycloak mastodon-web mastodon-sidekiq mastodon-streaming
      run_specs "mastodon,api.mastodon" tests/deep/oidc/mastodon.spec.ts
      ;;
    deep:ntfy)
      require_services caddy keycloak keycloak-auth-gateway ntfy
      run_specs "ntfy" tests/deep/forward-auth/ntfy.spec.ts
      ;;
    deep:onboarding)
      require_services caddy keycloak keycloak-auth-gateway onboarding
      run_specs "onboarding" tests/deep/forward-auth/onboarding.spec.ts tests/deep/forward-auth/onboarding-self-service.spec.ts
      ;;
    deep:pipeline)
      require_services caddy keycloak keycloak-auth-gateway airflow-webserver airflow-scheduler ingestion-runner
      run_specs "pipeline" tests/deep/forward-auth/pipeline.spec.ts
      ;;
    deep:planka)
      require_services caddy keycloak planka
      run_specs "planka" tests/deep/oidc/planka.spec.ts
      ;;
    deep:portal)
      require_services caddy keycloak keycloak-auth-gateway portal
      run_specs "apex,portal,homepage" tests/deep/forward-auth/homepage.spec.ts
      ;;
    deep:prometheus)
      require_services caddy keycloak keycloak-auth-gateway prometheus
      run_specs "prometheus" tests/deep/forward-auth/prometheus.spec.ts
      ;;
    deep:seafile)
      require_services caddy keycloak keycloak-auth-gateway seafile onlyoffice
      run_specs "seafile,api.seafile,onlyoffice" tests/deep/forward-auth/seafile.spec.ts
      ;;
    deep:search)
      require_services caddy keycloak keycloak-auth-gateway opensearch
      run_specs "search" tests/deep/forward-auth/search.spec.ts
      ;;
    deep:vaultwarden)
      require_services caddy keycloak keycloak-auth-gateway vaultwarden
      run_specs "vaultwarden,api.vaultwarden" tests/deep/forward-auth/vault.spec.ts tests/deep/forward-auth/vaultwarden-boundary.spec.ts tests/deep/oidc/vaultwarden.spec.ts
      ;;
    deep:workspaces)
      if [ "$ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED" != "1" ]; then
        printf 'Skipping %s: %s.\n' "$group" "$(isolated_docker_vm_socket_skip_reason)"
        return 0
      fi
      require_services caddy keycloak keycloak-auth-gateway workspace-provisioner
      run_specs "workspaces" tests/deep/forward-auth/workspaces.spec.ts tests/fast/workspaces-boundary.spec.ts
      ;;
    deep:session)
      require_services caddy keycloak keycloak-auth-gateway jupyterhub prometheus portal grafana bookstack
      run_specs "jupyterhub,prometheus,portal,grafana,bookstack" tests/deep/forward-auth/session.spec.ts tests/deep/oidc/session.spec.ts
      ;;
    visual:coverage)
      require_services caddy keycloak keycloak-auth-gateway portal
      run_specs "" tests/visual/caddy-ui-coverage.spec.ts
      ;;
    visual:portal)
      require_services caddy keycloak keycloak-auth-gateway portal
      run_specs "apex,portal" tests/visual/smoke-visual.spec.ts tests/visual/portal-role-dashboards.spec.ts
      ;;
    visual:progression)
      run_specs "" tests/visual/progression-dashboard.spec.ts
      ;;
    visual:apps)
      require_services caddy keycloak keycloak-auth-gateway alertmanager bookstack forgejo grafana onboarding portal progression opensearch airflow-webserver airflow-scheduler ingestion-runner
      run_specs "alerts,bookstack,forgejo,grafana,onboarding,portal,progress,search,pipeline" tests/visual/smoke-visual.spec.ts
      ;;
    visual:media)
      require_services caddy keycloak jellyfin mastodon-web mastodon-sidekiq mastodon-streaming seafile onlyoffice
      run_specs "jellyfin,mastodon,seafile,onlyoffice" tests/visual/smoke-visual.spec.ts
      ;;
    visual:utilities)
      require_services caddy keycloak keycloak-auth-gateway donetick erpnext homeassistant jupyterhub kopia ntfy planka prometheus qbittorrent vaultwarden sogo autobattler tas-dashboard
      run_specs "donetick,erpnext,homeassistant,jupyterhub,kopia,ntfy,planka,prometheus,qbittorrent,vaultwarden,sogo,autobattler,tas,tas-events" tests/visual/smoke-visual.spec.ts
      ;;
    visual:workspaces)
      if [ "$ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED" != "1" ]; then
        printf 'Skipping %s: %s.\n' "$group" "$(isolated_docker_vm_socket_skip_reason)"
        return 0
      fi
      require_services caddy keycloak keycloak-auth-gateway workspace-provisioner chatgpt-connector
      run_specs "workspaces,chatgpt-connector" tests/visual/smoke-visual.spec.ts
      ;;
    *)
      printf 'Unknown Playwright suite group: %s\n' "$group" >&2
      return 2
      ;;
  esac
}

run_composed() {
  local failed=0 group rc
  for group in "$@"; do
    printf '\n[playwright-suite] running %s\n' "$group" >&2
    if run_group "$group"; then
      rc=0
    else
      rc=$?
      failed=$((failed + 1))
      printf '[playwright-suite] %s failed with exit %s\n' "$group" "$rc" >&2
    fi
  done
  [ "$failed" -eq 0 ]
}

run_target() {
  local target="${1:-all}"
  case "$target" in
    deep)
      groups="deep:alertmanager deep:bookstack deep:element deep:forgejo deep:grafana deep:homeassistant deep:jellyfin deep:jupyterhub deep:keycloak deep:kopia deep:matrix deep:mastodon deep:ntfy deep:onboarding deep:planka deep:portal deep:prometheus deep:seafile deep:search deep:vaultwarden deep:session"
      if [ "${TESTDEV_SKIP_GPU_INGESTION:-0}" != "1" ]; then
        groups="$groups deep:pipeline"
      fi
      groups="$groups deep:workspaces"
      # shellcheck disable=SC2086
      run_composed $groups
      ;;
    deep:forward-auth)
      groups="deep:alertmanager deep:grafana deep:homeassistant deep:jupyterhub deep:kopia deep:ntfy deep:onboarding deep:portal deep:prometheus deep:seafile deep:search deep:vaultwarden deep:session"
      if [ "${TESTDEV_SKIP_GPU_INGESTION:-0}" != "1" ]; then
        groups="$groups deep:pipeline"
      fi
      groups="$groups deep:workspaces"
      # shellcheck disable=SC2086
      run_composed $groups
      ;;
    deep:oidc)
      groups="deep:bookstack deep:element deep:forgejo deep:grafana deep:jellyfin deep:keycloak deep:matrix deep:mastodon deep:planka deep:vaultwarden deep:session"
      # shellcheck disable=SC2086
      run_composed $groups
      ;;
    visual)
      groups="visual:coverage visual:portal visual:progression visual:apps visual:media visual:utilities visual:workspaces"
      # shellcheck disable=SC2086
      run_composed $groups
      ;;
    all)
      groups="boundary app-smoke sso deep visual"
      # shellcheck disable=SC2086
      run_composed $groups
      ;;
    *)
      run_group "$target"
      ;;
  esac
}

if [ "$#" -gt 1 ]; then
  failed=0
  for target in "$@"; do
    if run_target "$target"; then
      continue
    else
      rc=$?
      failed=$((failed + 1))
      printf '[playwright-suite] %s failed with exit %s\n' "$target" "$rc" >&2
    fi
  done
  exit "$failed"
fi

run_target "${1:-all}"
