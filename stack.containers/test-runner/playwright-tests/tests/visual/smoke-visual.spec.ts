import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import { authArtifactPath, loadTestUser } from '../../utils/auth-artifacts';
import { captureVisualSnapshot } from '../../utils/drivers/browser-route-driver';
import { defaultIdentityProvider } from '../../utils/identity-provider';
import { visualRoutes } from '../../utils/route-catalog';
import { serviceUrl } from '../../utils/stack-urls';

const sessionState = authArtifactPath(defaultIdentityProvider.sessionArtifactName);
const screenshotRoot = process.env.PLAYWRIGHT_SCREENSHOTS_DIR || '/app/test-results/screenshots';

const publicRoutes = visualRoutes.filter((route) => route.kind === 'public');
const authenticatedRoutes = visualRoutes.filter((route) => route.kind !== 'public');

async function seedQbittorrentVisualFixture(page: import('@playwright/test').Page): Promise<void> {
  const existing = await page.request.get(serviceUrl('qbittorrent', '/api/v2/torrents/info'));
  expect(existing.ok(), `qBittorrent transfer API returned HTTP ${existing.status()}`).toBe(true);
  if ((await existing.text()).includes('northstar-portal-backup.iso')) {
    return;
  }

  const response = await page.request.post(serviceUrl('qbittorrent', '/api/v2/torrents/add'), {
    multipart: {
      urls: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=northstar-portal-backup.iso',
      stopped: 'true',
      tags: 'examples,runbook',
    },
  });
  expect(response.ok(), `qBittorrent fixture API returned HTTP ${response.status()}`).toBe(true);
  expect(response.url()).toContain('/api/v2/torrents/add');
  expect((await response.text()).trim()).toBe('Ok.');

  const transfers = await page.request.get(serviceUrl('qbittorrent', '/api/v2/torrents/info'));
  expect(transfers.ok(), `qBittorrent transfer API returned HTTP ${transfers.status()}`).toBe(true);
  expect(await transfers.text()).toContain('northstar-portal-backup.iso');
}

function seedErpnextVisualUser(user: ReturnType<typeof loadTestUser>): void {
  const containerCli = process.env.TEST_RUNNER_CONTAINER_CLI || 'podman';
  const script = String.raw`
cd /home/frappe/frappe-bench
bench --site "$ERPNEXT_SITE_NAME" console <<'PY'
import os

email = os.environ['PLAYWRIGHT_ERPNEXT_EMAIL'].strip().lower()
roles = ['Desk User', 'Employee', 'Projects User', 'Purchase User', 'Accounts User', 'Sales User', 'Stock User']

user = frappe.get_doc('User', email) if frappe.db.exists('User', email) else frappe.new_doc('User')
user.email = email
user.first_name = 'Playwright'
user.last_name = 'User'
user.enabled = 1
user.user_type = 'System User'
user.send_welcome_email = 0
existing = {row.role for row in user.roles}
available = {row.name for row in frappe.get_all('Role', fields=['name'], limit_page_length=0)}
for role in roles:
    if role in available and role not in existing:
        user.append('roles', {'role': role})
if user.is_new():
    user.insert(ignore_permissions=True)
else:
    user.save(ignore_permissions=True, ignore_version=True)

if not frappe.db.exists('Supplier', 'Northstar Hosting'):
    supplier_groups = frappe.get_all('Supplier Group', pluck='name', limit_page_length=1)
    if not supplier_groups:
        raise RuntimeError('ERPNext fixture requires at least one Supplier Group')
    supplier = frappe.new_doc('Supplier')
    supplier.supplier_name = 'Northstar Hosting'
    supplier.supplier_group = supplier_groups[0]
    supplier.supplier_type = 'Company'
    supplier.country = 'Australia'
    supplier.insert(ignore_permissions=True)
frappe.db.commit()
PY
`;
  execFileSync(containerCli, [
    'exec',
    '--env', `PLAYWRIGHT_ERPNEXT_EMAIL=${user.email}`,
    '--env', `ERPNEXT_SITE_NAME=erpnext.${process.env.DOMAIN || 'datamancy.net'}`,
    'erpnext-backend',
    'bash',
    '-lc',
    script,
  ], {
    env: process.env,
    stdio: 'pipe',
    timeout: 60000,
  });
}

test.describe('Visual Smoke', () => {
  for (const route of publicRoutes) {
    test(`${route.label} snapshot`, async ({ page }) => {
      test.setTimeout(120000);
      await captureVisualSnapshot(page, route, loadTestUser(), screenshotRoot);
    });
  }

  test.describe('Authenticated snapshots', () => {
    test.use({ storageState: sessionState });

    for (const route of authenticatedRoutes) {
      test(`${route.label} snapshot`, async ({ page }) => {
        test.setTimeout(120000);
        const user = loadTestUser();
        if (route.host === 'qbittorrent') {
          await seedQbittorrentVisualFixture(page);
        }
        if (route.host === 'erpnext') {
          seedErpnextVisualUser(user);
        }
        await captureVisualSnapshot(page, route, user, screenshotRoot);
      });
    }
  });
});
