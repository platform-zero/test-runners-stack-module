import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const visualSuiteScript = path.join(repoRoot, 'scripts/run-visual-suite.sh');
const modularSuiteScript = path.join(repoRoot, 'scripts/run-playwright-suite.sh');

function suiteSpecPaths(scriptPath: string): string[] {
  const script = fs.readFileSync(scriptPath, 'utf8');
  return [...script.matchAll(/\btests\/[^\s\\]+\.spec\.ts\b/g)].map((match) => match[0]);
}

function suiteCaseBody(script: string, suiteName: string): string {
  const match = script.match(new RegExp(`${suiteName.replace(':', '\\\\:')}\\)\\n([\\s\\S]*?)\\n\\s*;;`));
  return match?.[1] ?? '';
}

describe('visual suite script', () => {
  it('keeps the legacy visual entrypoint as a thin wrapper', () => {
    const script = fs.readFileSync(visualSuiteScript, 'utf8');
    expect(script).toContain('run-playwright-suite.sh');
    expect(script).toContain('visual');
  });

  it('references only existing Playwright spec files from the modular registry', () => {
    const missingSpecs = suiteSpecPaths(modularSuiteScript).filter((specPath) => {
      return !fs.existsSync(path.join(repoRoot, specPath));
    });

    expect(missingSpecs).toEqual([]);
  });

  it('does not require optional VM-only services for the default visual suite unconditionally', () => {
    const script = fs.readFileSync(modularSuiteScript, 'utf8');
    expect(script).toContain('visual:workspaces)');
    expect(script).toContain('ISOLATED_DOCKER_VM_IDENTITY_CONFIGURED');
  });

  it('keeps visual groups free of deep service specs', () => {
    const script = fs.readFileSync(modularSuiteScript, 'utf8');
    const visualSuites = ['visual:coverage', 'visual:portal', 'visual:progression', 'visual:apps', 'visual:media', 'visual:utilities', 'visual:workspaces'];

    for (const suiteName of visualSuites) {
      expect(suiteCaseBody(script, suiteName)).not.toContain('tests/deep/');
    }
  });
});
