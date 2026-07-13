import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const visualSuiteScript = path.join(repoRoot, 'scripts/run-visual-suite.sh');
const modularSuiteScript = path.join(repoRoot, 'scripts/run-playwright-suite.sh');
const managedRunnerDockerfilePaths = [
  path.resolve(repoRoot, '../Dockerfile'),
  '/app/repo-fixtures/test-runner/Dockerfile',
];
const specOwnershipPaths = [
  path.join(repoRoot, 'config/playwright-spec-ownership.json'),
  path.resolve(repoRoot, '../../../stack.config/test-runner/playwright-spec-ownership.json'),
];
const stackModulePath = path.resolve(repoRoot, '../../../stack.module.json');

type SpecOwnership = {
  owner: string;
  source: 'module' | 'test-runners';
  reason?: string;
};

function loadSpecOwnership(): Record<string, SpecOwnership> {
  const specOwnershipPath = specOwnershipPaths.find((candidate) => fs.existsSync(candidate));
  if (!specOwnershipPath) {
    throw new Error(`missing Playwright spec ownership manifest; tried ${specOwnershipPaths.join(', ')}`);
  }
  const manifest = JSON.parse(fs.readFileSync(specOwnershipPath, 'utf8')) as {
    specs?: Record<string, SpecOwnership>;
  };
  return manifest.specs ?? {};
}

function suiteSpecPaths(scriptPath: string): string[] {
  const script = fs.readFileSync(scriptPath, 'utf8');
  return [...script.matchAll(/\btests\/[^\s\\]+\.spec\.ts\b/g)].map((match) => match[0]);
}

function suiteCaseBody(script: string, suiteName: string): string {
  const match = script.match(new RegExp(`${suiteName.replace(':', '\\\\:')}\\)\\n([\\s\\S]*?)\\n\\s*;;`));
  return match?.[1] ?? '';
}

function isStandaloneTestRunnersModule(): boolean {
  if (!fs.existsSync(stackModulePath)) {
    return false;
  }
  const manifest = JSON.parse(fs.readFileSync(stackModulePath, 'utf8')) as { id?: string };
  return manifest.id === 'test-runners';
}

describe('visual suite script', () => {
  it('keeps the legacy visual entrypoint as a thin wrapper', () => {
    const script = fs.readFileSync(visualSuiteScript, 'utf8');
    expect(script).toContain('run-playwright-suite.sh');
    expect(script).toContain('visual');
  });

  it('classifies every Playwright spec referenced by the modular registry', () => {
    const ownership = loadSpecOwnership();
    const unclassifiedSpecs = suiteSpecPaths(modularSuiteScript).filter((specPath) => !ownership[specPath]);

    expect(unclassifiedSpecs).toEqual([]);
  });

  it('references only local or module-owned Playwright spec files from the modular registry', () => {
    const ownership = loadSpecOwnership();
    const missingSpecs = suiteSpecPaths(modularSuiteScript).filter((specPath) => {
      return !fs.existsSync(path.join(repoRoot, specPath)) && ownership[specPath]?.source !== 'module';
    });

    expect(missingSpecs).toEqual([]);
  });

  it('keeps module-owned specs out of the standalone test-runners module', () => {
    if (!isStandaloneTestRunnersModule()) {
      return;
    }

    const ownership = loadSpecOwnership();
    const centralizedModuleSpecs = Object.entries(ownership)
      .filter(([, entry]) => entry.source === 'module')
      .map(([specPath]) => specPath)
      .filter((specPath) => fs.existsSync(path.join(repoRoot, specPath)));

    expect(centralizedModuleSpecs).toEqual([]);
  });

  it('does not route visual coverage through removed workspace-specific suites', () => {
    const script = fs.readFileSync(modularSuiteScript, 'utf8');
    expect(script).not.toMatch(/visual:[a-z-]*workspace[a-z-]*\)/);
  });

  it('keeps visual groups free of deep service specs', () => {
    const script = fs.readFileSync(modularSuiteScript, 'utf8');
    const visualSuites = ['visual:coverage', 'visual:portal', 'visual:apps', 'visual:media', 'visual:utilities'];

    for (const suiteName of visualSuites) {
      expect(suiteCaseBody(script, suiteName)).not.toContain('tests/deep/');
    }
  });

  it('keeps qBittorrent in the visual utilities suite', () => {
    const script = fs.readFileSync(modularSuiteScript, 'utf8');
    expect(script).toContain('visual:utilities)');
    expect(script).toContain('qbittorrent');
  });

  it('keeps module-owned visual fixtures out of the central runner image', () => {
    const managedRunnerDockerfile = managedRunnerDockerfilePaths.find((candidate) => fs.existsSync(candidate));
    if (!managedRunnerDockerfile) {
      throw new Error(`missing managed runner Dockerfile fixture; tried ${managedRunnerDockerfilePaths.join(', ')}`);
    }
    const dockerfile = fs.readFileSync(managedRunnerDockerfile, 'utf8');

  });
});
