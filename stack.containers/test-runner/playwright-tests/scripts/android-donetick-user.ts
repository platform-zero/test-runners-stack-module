import { chromium } from 'playwright';
import type { TestUser } from '../utils/test-user';

export async function withDonetickNativeUser<T>(
  domain: string, user: TestUser, action: () => Promise<T>,
): Promise<T> {
  if (!user.password) throw new Error('donetick-managed-password-missing');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let token = '';
  try {
    await page.goto(`https://donetick.${domain}/login`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).hostname === `keycloak.${domain}`) {
      await page.locator('#username').fill(user.username);
      await page.locator('#password').fill(user.password);
      await page.locator('#kc-login').click();
      await page.waitForURL((url) => url.hostname === `donetick.${domain}`, { timeout: 60_000 });
    }
    const oidcButton = page.getByText(/continue with keycloak/i);
    const oidcVisible = await oidcButton.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (oidcVisible) {
      await oidcButton.click();
      if (new URL(page.url()).hostname === `keycloak.${domain}`) {
        await page.locator('#username').fill(user.username);
        await page.locator('#password').fill(user.password);
        await page.locator('#kc-login').click();
      }
      await page.waitForURL((url) => url.hostname === `donetick.${domain}`, { timeout: 60_000 });
    }
    await page.waitForFunction(() => Boolean(localStorage.getItem('token')), undefined, { timeout: 60_000 });
    token = await page.evaluate(() => localStorage.getItem('token') || '');
    const changed = await page.evaluate(async ({ bearer, password }) => {
      const response = await fetch('/api/v1/users/change_password', {
        method: 'PUT', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      return response.status;
    }, { bearer: token, password: user.password });
    if (changed !== 200) throw new Error(`donetick-password-provision:${changed}`);
    return await action();
  } finally {
    if (token) {
      const deletion = await page.evaluate(async ({ bearer, password }) => {
        const response = await fetch('/api/v1/users/delete', {
          method: 'DELETE', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ password, confirmation: 'DELETE' }),
        });
        return response.status;
      }, { bearer: token, password: user.password }).catch(() => 0);
      if (deletion !== 200) process.stderr.write(`[android-native] donetick-cleanup-status=${deletion}\n`);
    }
    await browser.close();
  }
}
