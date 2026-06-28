import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildEvidenceTargets, collectScreenshotFiles, createScreenshotRecord, generateHTML } from '../../generate-screenshot-report';

describe('generate-screenshot-report', () => {
  it('classifies authenticated captures as service proofs', () => {
    const screenshot = createScreenshotRecord('vaultwarden-oidc-authenticated.jpg', 1024);

    expect(screenshot.kind).toBe('service-proof');
    expect(screenshot.authType).toBe('oidc');
    expect(screenshot.title).toBe('Vaultwarden');
  });

  it('classifies proof captures without auth suffixes as feature proofs', () => {
    const screenshot = createScreenshotRecord('mastodon-federated-preview-card-rendered.jpeg', 2048);

    expect(screenshot.kind).toBe('feature-proof');
    expect(screenshot.authType).toBe('unknown');
    expect(screenshot.title).toBe('Mastodon Federated Preview Card Rendered');
  });

  it('renders a proof report with service, feature, and manifest sections', () => {
    const html = generateHTML(
      [
        {
          relativePath: 'bookstack-authenticated.jpg',
          filename: 'bookstack-authenticated.jpg',
          stem: 'bookstack-authenticated',
          title: 'Bookstack',
          kind: 'service-proof',
          authType: 'forward-auth',
          size: 1024,
          sizeFormatted: '1.0 KB',
        },
        {
          relativePath: 'portal/role-dashboards/portal-role-dashboards.png',
          filename: 'portal-role-dashboards.png',
          stem: 'portal-role-dashboards',
          title: 'Portal Role Dashboards',
          kind: 'feature-proof',
          authType: 'unknown',
          size: 2048,
          sizeFormatted: '2.0 KB',
        },
      ],
      buildEvidenceTargets({
        components: [
          { component: 'portal', screenshots: ['portal/authenticated', 'portal/profile-dashboard'] },
          { component: 'progression', screenshots: ['progression/ops-cockpit'] },
        ],
      })
    );

    expect(html).toContain('Service Proof Screenshots');
    expect(html).toContain('Feature Proof Screenshots');
    expect(html).toContain('Declared Feature Proof Targets');
    expect(html).toContain('portal/authenticated');
    expect(html).toContain('progression/ops-cockpit');
  });

  it('collects screenshots recursively from module subdirectories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-report-'));
    fs.mkdirSync(path.join(root, 'portal', 'role-dashboards'), { recursive: true });
    fs.writeFileSync(path.join(root, 'portal', 'role-dashboards', '01-employee.png'), 'x');
    fs.writeFileSync(path.join(root, 'mastodon-federated-avatar-rendered.jpeg'), 'x');

    expect(collectScreenshotFiles(root)).toEqual([
      'mastodon-federated-avatar-rendered.jpeg',
      path.join('portal', 'role-dashboards', '01-employee.png'),
    ]);
  });
});
