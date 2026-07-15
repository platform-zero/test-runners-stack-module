import { devices, test } from '@playwright/test';
import { assertSmokeContract } from '../../utils/drivers/browser-route-driver';
import { mobileSmokeRoutes } from '../../utils/route-catalog';
import { withManagedBrowserUser } from '../../utils/managed-browser-user';

const mobileDevices = [
  { label: 'iPhone', device: devices['iPhone 13'] },
  { label: 'Pixel', device: devices['Pixel 7'] },
];

test.describe('Mobile App Smoke', () => {
  test.describe.configure({ mode: 'serial' });

  for (const { label, device } of mobileDevices) {
    test(`${label} routes render authenticated mobile UI without auth loops`, async ({ browser }) => {
      test.setTimeout(Math.max(120_000, mobileSmokeRoutes.length * 60_000));

      await withManagedBrowserUser(`m${label.toLowerCase()[0]}`, async (user) => {
        const context = await browser.newContext({
          ...device,
          ignoreHTTPSErrors: process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === 'true',
        });
        const page = await context.newPage();
        try {
          for (const route of mobileSmokeRoutes) {
            await test.step(`${label} ${route.label}`, async () => {
              await assertSmokeContract(page, route, user);
            });
          }
        } finally {
          await context.close();
        }
      });
    });
  }
});
