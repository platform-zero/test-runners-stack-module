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

describe('suite orchestration', () => {
  it('keeps the default runner target non fail-fast', () => {
    const script = fs.readFileSync(runnerScript, 'utf8');

    expect(script).not.toContain('run_runner suite stack-contract &&');
    expect(script).toContain('for step in \\');
    expect(script).toContain('run_runner "${step_args[@]}"');
  });

  it('batches the core Playwright smoke targets without chaining', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.test).toContain('npm run test:unit || status=$?; npm run test:e2e || status=$?;');
    expect(packageJson.scripts?.['test:e2e']).toContain('run-playwright-suite.sh boundary app-smoke sso');
    expect(packageJson.scripts?.['test:e2e']).not.toContain('&&');
  });

  it('supports batched Playwright suite targets', () => {
    const script = fs.readFileSync(suiteScript, 'utf8');

    expect(script).toContain('if [ "$#" -gt 1 ]');
    expect(script).toContain('run_target "$target"');
  });
});
