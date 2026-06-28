#!/usr/bin/env node
/**
 * Generate an HTML report showing captured screenshot proofs from test runs.
 *
 * The report separates:
 * - service proofs: authenticated route captures used to validate runtime access
 * - feature proofs: contract-backed UI evidence and module-specific proof shots
 *
 * Run after tests: npm run screenshot-report
 */

import * as fs from 'fs';
import * as path from 'path';

function resolveScreenshotsDir(): string {
  const candidates = [
    process.env.PLAYWRIGHT_SCREENSHOTS_DIR,
    path.join(__dirname, 'test-results', 'screenshots'),
    path.resolve(__dirname, '../../../../../../webservices-test-results/playwright/screenshots'),
    path.resolve(__dirname, '../../../../../../webservices-test-results/screenshots'),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim().length > 0));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.join(__dirname, 'test-results', 'screenshots');
}

const SCREENSHOTS_DIR = resolveScreenshotsDir();
const OUTPUT_FILE = path.join(path.dirname(SCREENSHOTS_DIR), 'screenshot-report.html');
const EVIDENCE_COVERAGE_CANDIDATES = [
  process.env.SCREENSHOT_EVIDENCE_COVERAGE_FILE,
  path.resolve(__dirname, '../../../../sso-stack-generator/dist/build/reports/evidence-coverage.json'),
  path.resolve(__dirname, '../../../../sso-stack-generator/build/reports/evidence-coverage.json'),
].filter((candidate): candidate is string => Boolean(candidate && candidate.trim().length > 0));

type ScreenshotKind = 'service-proof' | 'feature-proof';

interface Screenshot {
  relativePath: string;
  filename: string;
  stem: string;
  title: string;
  kind: ScreenshotKind;
  authType: 'forward-auth' | 'oidc' | 'unknown';
  size: number;
  sizeFormatted: string;
}

interface EvidenceCoverageTarget {
  component: string;
  target: string;
}

interface EvidenceCoverageFile {
  generatedAt?: string;
  components?: Array<{
    component: string;
    screenshots?: string[];
  }>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanize(value: string): string {
  return value
    .replace(/\.[^.]+$/i, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function classifyAuthType(stem: string): Screenshot['authType'] {
  if (/-oidc-authenticated$/i.test(stem)) {
    return 'oidc';
  }
  if (/-authenticated$/i.test(stem) || /-protected$/i.test(stem)) {
    return 'forward-auth';
  }
  return 'unknown';
}

function createScreenshotRecord(relativePath: string, size: number): Screenshot {
  const filename = path.basename(relativePath);
  const stem = filename.replace(/\.(png|jpe?g)$/i, '');
  const authType = classifyAuthType(stem);
  const kind: ScreenshotKind = authType === 'unknown' ? 'feature-proof' : 'service-proof';
  const title = humanize(
    authType === 'unknown'
      ? stem
      : stem
          .replace(/-oidc-authenticated$/i, '')
          .replace(/-authenticated$/i, '')
          .replace(/-protected$/i, '')
  );

  return {
    relativePath,
    filename,
    stem,
    title,
    kind,
    authType,
    size,
    sizeFormatted: formatBytes(size),
  };
}

function parseScreenshotFilename(filename: string): Screenshot {
  const stats = fs.statSync(path.join(SCREENSHOTS_DIR, filename));
  return createScreenshotRecord(filename, stats.size);
}

function collectScreenshotFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (/\.(png|jpe?g)$/i.test(entry.name)) {
        results.push(path.relative(rootDir, absolute));
      }
    }
  };

  walk(rootDir);
  return results.sort((left, right) => left.localeCompare(right));
}

function readEvidenceCoverageFile(): EvidenceCoverageFile | null {
  for (const candidate of EVIDENCE_COVERAGE_CANDIDATES) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    return JSON.parse(fs.readFileSync(candidate, 'utf-8')) as EvidenceCoverageFile;
  }

  return null;
}

function buildEvidenceTargets(evidenceCoverage: EvidenceCoverageFile | null): EvidenceCoverageTarget[] {
  const targets = evidenceCoverage?.components ?? [];

  return targets.flatMap((component) =>
    (component.screenshots ?? []).map((target) => ({
      component: component.component,
      target,
    }))
  );
}

function generateHTML(screenshots: Screenshot[], evidenceTargets: EvidenceCoverageTarget[], evidenceGeneratedAt?: string): string {
  const serviceScreenshots = screenshots.filter((screenshot) => screenshot.kind === 'service-proof');
  const featureScreenshots = screenshots.filter((screenshot) => screenshot.kind === 'feature-proof');

  const renderScreenshotSection = (title: string, screenshots: Screenshot[]) => {
    if (screenshots.length === 0) return '';

    return `
      <section>
        <h2>${title}</h2>
        <div class="screenshot-grid">
          ${screenshots
            .map(
              (screenshot) => `
            <div class="screenshot-card">
              <h3>${screenshot.title}</h3>
              <div class="screenshot-info">
                <span class="badge ${screenshot.kind}">${screenshot.kind}</span>
                <span class="badge ${screenshot.authType}">${screenshot.authType}</span>
                <span class="size">${screenshot.sizeFormatted}</span>
              </div>
              <a href="screenshots/${screenshot.relativePath}" target="_blank" rel="noreferrer">
                <img
                  src="screenshots/${screenshot.relativePath}"
                  alt="${screenshot.title} screenshot"
                  loading="lazy"
                />
              </a>
              <div class="filename">${screenshot.relativePath}</div>
            </div>
          `
            )
            .join('\n')}
        </div>
      </section>
    `;
  };

  const renderEvidenceTargets = (targets: EvidenceCoverageTarget[]) => {
    if (targets.length === 0) {
      return `
        <section>
          <h2>Declared Feature Proof Targets</h2>
          <div class="empty-state">
            <div class="empty-state-icon">📄</div>
            <h3>No evidence manifest found</h3>
            <p>The gallery can still review captured screenshots, but there is no contract evidence report to compare against.</p>
          </div>
        </section>
      `;
    }

    const groupedTargets = targets.reduce<Record<string, string[]>>((acc, target) => {
      acc[target.component] = acc[target.component] ?? [];
      acc[target.component].push(target.target);
      return acc;
    }, {});

    return `
      <section>
        <h2>Declared Feature Proof Targets</h2>
        <div class="target-grid">
          ${Object.entries(groupedTargets)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(
              ([component, componentTargets]) => `
              <div class="target-card">
                <h3>${humanize(component)}</h3>
                <div class="target-list">
                  ${componentTargets
                    .sort((left, right) => left.localeCompare(right))
                    .map((target) => `<span class="target-chip">${target}</span>`)
                    .join('')}
                </div>
              </div>
            `
            )
            .join('')}
        </div>
      </section>
    `;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Platform Screenshot Proof Report - ${new Date().toISOString()}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      padding: 2rem;
      line-height: 1.6;
    }

    header {
      max-width: 1400px;
      margin: 0 auto 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 2px solid #30363d;
    }

    h1 {
      font-size: 2.25rem;
      margin-bottom: 0.5rem;
      color: #58a6ff;
    }

    .subtitle {
      color: #8b949e;
      font-size: 1rem;
      max-width: 80ch;
    }

    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem 2rem;
      margin-top: 1rem;
      font-size: 0.95rem;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .stat-value {
      font-weight: 700;
      color: #58a6ff;
      font-size: 1.4rem;
    }

    .stat-label {
      color: #8b949e;
    }

    section {
      max-width: 1400px;
      margin: 0 auto 3rem;
    }

    h2 {
      font-size: 1.45rem;
      margin-bottom: 1rem;
      color: #f0883e;
    }

    .screenshot-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
    }

    .screenshot-card,
    .target-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      overflow: hidden;
    }

    .screenshot-card h3,
    .target-card h3 {
      padding: 1rem;
      font-size: 1rem;
      color: #c9d1d9;
      border-bottom: 1px solid #30363d;
    }

    .screenshot-info {
      padding: 0.75rem 1rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      background: #0d1117;
      border-bottom: 1px solid #30363d;
    }

    .badge {
      display: inline-block;
      padding: 0.2rem 0.65rem;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .badge.service-proof {
      background: #1f6feb;
      color: #fff;
    }

    .badge.feature-proof {
      background: #2ea043;
      color: #fff;
    }

    .badge.forward-auth {
      background: #8b5cf6;
      color: #fff;
    }

    .badge.oidc {
      background: #d29922;
      color: #111;
    }

    .badge.unknown {
      background: #8b949e;
      color: #111;
    }

    .size {
      color: #8b949e;
      font-size: 0.85rem;
      margin-left: auto;
    }

    .screenshot-card a {
      display: block;
      position: relative;
      overflow: hidden;
      background: #0d1117;
    }

    .screenshot-card img {
      width: 100%;
      height: 240px;
      object-fit: cover;
      object-position: top;
      display: block;
      transition: transform 0.3s;
    }

    .screenshot-card:hover img {
      transform: scale(1.03);
    }

    .filename {
      padding: 0.75rem 1rem;
      font-size: 0.8rem;
      color: #8b949e;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      word-break: break-all;
      background: #0d1117;
    }

    .target-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }

    .target-list {
      padding: 1rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .target-chip {
      display: inline-flex;
      padding: 0.25rem 0.55rem;
      border-radius: 999px;
      background: #21262d;
      color: #c9d1d9;
      font-size: 0.78rem;
      word-break: break-word;
    }

    .empty-state {
      text-align: center;
      padding: 3rem 2rem;
      color: #8b949e;
      border: 1px dashed #30363d;
      border-radius: 8px;
      background: #161b22;
    }

    .empty-state-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    footer {
      max-width: 1400px;
      margin: 3rem auto 0;
      padding-top: 1.5rem;
      border-top: 1px solid #30363d;
      text-align: center;
      color: #8b949e;
      font-size: 0.9rem;
    }

    @media (max-width: 768px) {
      .screenshot-grid,
      .target-grid {
        grid-template-columns: 1fr;
      }

      h1 {
        font-size: 1.75rem;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Platform Screenshot Proof Report</h1>
    <div class="subtitle">
      Service proof screenshots validate authenticated route access. Feature proof screenshots come from contract-backed module evidence and module-owned flows.
    </div>
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${screenshots.length}</div>
        <div class="stat-label">Total screenshots</div>
      </div>
      <div class="stat">
        <div class="stat-value">${serviceScreenshots.length}</div>
        <div class="stat-label">Service proofs</div>
      </div>
      <div class="stat">
        <div class="stat-value">${featureScreenshots.length}</div>
        <div class="stat-label">Feature proofs</div>
      </div>
      <div class="stat">
        <div class="stat-value">${evidenceTargets.length}</div>
        <div class="stat-label">Declared feature targets</div>
      </div>
    </div>
  </header>

  ${renderScreenshotSection('Service Proof Screenshots', serviceScreenshots)}
  ${renderScreenshotSection('Feature Proof Screenshots', featureScreenshots)}
  ${renderEvidenceTargets(evidenceTargets)}

  ${screenshots.length === 0 ? `
    <section>
      <div class="empty-state">
        <div class="empty-state-icon">📸</div>
        <h2>No screenshots found</h2>
        <p>Run the Playwright suites first to generate screenshot proofs.</p>
      </div>
    </section>
  ` : ''}

  <footer>
    <p>Generated at ${new Date().toLocaleString()}</p>
    <p>${evidenceGeneratedAt ? `Contract evidence generated at ${evidenceGeneratedAt}.` : 'No contract evidence manifest was found.'}</p>
  </footer>
</body>
</html>`;
}

function main() {
  console.log('Generating screenshot proof report...');

  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.log(`Screenshots directory not found: ${SCREENSHOTS_DIR}`);
    console.log('Run tests first to generate screenshots.');
    process.exit(1);
  }

  const files = collectScreenshotFiles(SCREENSHOTS_DIR);

  const screenshots = files.map(parseScreenshotFilename);
  const evidenceCoverage = readEvidenceCoverageFile();
  const evidenceTargets = buildEvidenceTargets(evidenceCoverage);

  console.log(`Found ${files.length} screenshots`);
  console.log(`Found ${evidenceTargets.length} declared feature proof targets`);

  screenshots.forEach((screenshot) => {
    console.log(
      `${screenshot.kind.padEnd(14)} ${screenshot.authType.padEnd(13)} ${screenshot.title.padEnd(36)} ${screenshot.sizeFormatted}`
    );
  });

  const html = generateHTML(screenshots, evidenceTargets, evidenceCoverage?.generatedAt);
  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');

  console.log(`Report generated: ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

export {
  buildEvidenceTargets,
  createScreenshotRecord,
  classifyAuthType,
  formatBytes,
  generateHTML,
  collectScreenshotFiles,
  humanize,
  main,
  parseScreenshotFilename,
  readEvidenceCoverageFile,
};
