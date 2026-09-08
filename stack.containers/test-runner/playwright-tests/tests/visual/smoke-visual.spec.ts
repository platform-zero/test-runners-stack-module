import { expect, test } from '@playwright/test';
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

  await expect.poll(async () => {
    const transfers = await page.request.get(serviceUrl('qbittorrent', '/api/v2/torrents/info'));
    expect(transfers.ok(), `qBittorrent transfer API returned HTTP ${transfers.status()}`).toBe(true);
    return await transfers.text();
  }, {
    timeout: 15000,
    message: 'qBittorrent should persist the seeded transfer through its API',
  }).toContain('northstar-portal-backup.iso');
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
        await captureVisualSnapshot(page, route, user, screenshotRoot);
      });
    }
  });
});
