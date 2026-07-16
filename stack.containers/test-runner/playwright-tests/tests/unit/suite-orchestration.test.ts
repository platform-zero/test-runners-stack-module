import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const suiteScript = path.join(repoRoot, 'scripts/run-playwright-suite.sh');
const packageJsonPath = path.join(repoRoot, 'package.json');

function resolveRunnerScript(): string {
  const candidates = [
    process.env.TEST_RUNNER_SCRIPT,
    '/app/stack.containers/test-runner/run-tests.sh',
    path.resolve(repoRoot, '..', 'run-tests.sh'),
    path.resolve(repoRoot, '..', '..', 'run-tests.sh'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const runnerScript = candidates.find((candidate) => fs.existsSync(candidate));
  if (!runnerScript) {
    throw new Error(`Unable to find run-tests.sh. Checked: ${candidates.join(', ')}`);
  }

  return runnerScript;
}

const runnerScript = resolveRunnerScript();

function resolveRequiredFile(label: string, candidates: string[]): string {
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(`Unable to find ${label}. Checked: ${candidates.join(', ')}`);
  }
  return resolved;
}

describe('suite orchestration', () => {
  it('keeps the default runner target non fail-fast', () => {
    const script = fs.readFileSync(runnerScript, 'utf8');

    expect(script).not.toContain('run_runner suite stack-contract &&');
    expect(script).toContain('for step in \\');
    expect(script).toContain('run_runner "${step_args[@]}"');
  });

  it('uses the workload domain socket and a test-user-owned Podman runtime', () => {
    const script = fs.readFileSync(runnerScript, 'utf8');
    const entrypointPath = resolveRequiredFile('container-entrypoint.sh', [
      '/container-entrypoint.sh',
      path.resolve(repoRoot, '..', 'container-entrypoint.sh'),
    ]);
    const entrypoint = fs.readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('TEST_RUNNER_MANAGED_SOCKET_USER="${TEST_RUNNER_MANAGED_SOCKET_USER:-$WEBSERVICES_ROOTLESS_USER}"');
    expect(entrypoint).toContain('TEST_USER_RUNTIME_DIR="${TEST_USER_HOME}/.podman-remote-runtime"');
    expect(entrypoint).toContain('XDG_RUNTIME_DIR="$TEST_USER_RUNTIME_DIR"');
  });

  it('forces container-control subprocesses through the Podman remote client', () => {
    const wrapperPath = resolveRequiredFile('Podman remote wrapper', [
      '/usr/local/bin/webservices-podman-remote',
      path.resolve(repoRoot, '..', 'podman-remote'),
    ]);
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(wrapper).toContain('podman --remote "$@"');
    expect(fs.readFileSync(runnerScript, 'utf8')).toContain(
      'TEST_RUNNER_CONTAINER_CLI=/usr/local/bin/webservices-podman-remote'
    );
  });

  it('mounts the live Caddy trust bundle before static release fallbacks', () => {
    const script = fs.readFileSync(runnerScript, 'utf8');
    const liveBundle = script.indexOf('"$CADDY_CA_HOST_PATH"');
    const staticFallback = script.indexOf('runtime/configs/grafana/caddy-ca.crt');

    expect(script).toContain('CADDY_CA_HOST_PATH="${CADDY_CA_HOST_PATH:-/mnt/stack/volumes/caddy_ca/caddy-ca.crt}"');
    expect(liveBundle).toBeGreaterThan(0);
    expect(staticFallback).toBeGreaterThan(liveBundle);
  });

  it('batches the core Playwright smoke targets without chaining', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.test).toContain('npm run test:unit || status=$?; npm run test:e2e || status=$?;');
    expect(packageJson.scripts?.['test:e2e']).toContain('run-playwright-suite.sh boundary app-smoke sso');
    expect(packageJson.scripts?.['test:e2e']).not.toContain('&&');
    expect(packageJson.scripts?.['test:e2e:mobile']).toContain('run-playwright-suite.sh mobile');
    expect(packageJson.scripts?.['test:e2e:mobile-smoke']).toContain('run-playwright-suite.sh mobile:smoke');
    expect(packageJson.scripts?.['test:e2e:mobile-auth']).toContain('run-playwright-suite.sh mobile:auth');
  });

  it('supports batched Playwright suite targets', () => {
    const script = fs.readFileSync(suiteScript, 'utf8');

    expect(script).toContain('if [ "$#" -gt 1 ]');
    expect(script).toContain('run_target "$target"');
  });

  it('preserves per-group Playwright artifacts during aggregate runs', () => {
    const script = fs.readFileSync(suiteScript, 'utf8');
    const config = fs.readFileSync(path.join(repoRoot, 'playwright.config.ts'), 'utf8');

    expect(script).toContain('PLAYWRIGHT_RUN_LABEL="${group//:/-}"');
    expect(config).toContain("artifactPath('test-results')");
    expect(config).toContain("artifactPath('playwright-report')");
  });

  it('invokes the visual validator through its package entrypoint rather than a copied bin shim', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['test:e2e:visual']).toContain('node node_modules/ts-node/dist/bin.js');
    expect(packageJson.scripts?.['test:e2e:visual:review']).toContain('node node_modules/ts-node/dist/bin.js');
  });

  it('registers every deep Playwright spec in the deep aggregate orchestration', () => {
    const script = fs.readFileSync(suiteScript, 'utf8');
    const deepRoot = path.join(repoRoot, 'tests', 'deep');
    const specs = fs.readdirSync(deepRoot, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.spec.ts'))
      .map((entry) => `tests/deep/${entry.split(path.sep).join('/')}`)
      .sort();

    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(script).toContain(spec);
    }

    const forwardAggregate = script.match(/run_deep_forward_auth\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const oidcAggregate = script.match(/run_deep_oidc\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const invokedGroups = new Set(
      [...`${forwardAggregate}\n${oidcAggregate}`.matchAll(/\bdeep:[a-z-]+\b/g)].map((match) => match[0])
    );
    const groupCases = [...script.matchAll(/^    (deep:[a-z-]+)\)\n([\s\S]*?)^      ;;/gm)]
      .map((match) => ({ name: match[1], body: match[2] }));

    for (const spec of specs) {
      const aggregateOwners = groupCases
        .filter((group) => group.body.includes(spec) && invokedGroups.has(group.name))
        .map((group) => group.name);
      expect({ spec, aggregateOwners }).toEqual({ spec, aggregateOwners: [expect.any(String)] });
    }
  });
});
