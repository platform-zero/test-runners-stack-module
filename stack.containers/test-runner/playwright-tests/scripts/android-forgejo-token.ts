import { chromium } from 'playwright';
import type { TestUser } from '../utils/test-user';

export async function withForgejoToken<T>(
  domain: string, user: TestUser, action: (token: string) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const origin = `https://forgejo.${domain}`;
  const name = `android-native-${Date.now().toString(36)}`;
  let createdToken = false;
  try {
    await page.goto(`${origin}/user/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('a.oauth-login-link[href*="Keycloak"]').click();
    await page.locator('#username').fill(user.username);
    await page.locator('#password').fill(user.password || '');
    await page.locator('#kc-login').click();
    await page.waitForURL((url) => url.hostname === `forgejo.${domain}`, { timeout: 60_000 });
    await page.goto(`${origin}/user/settings/applications`, { waitUntil: 'domcontentloaded' });
    const created = await context.request.post(`${origin}/user/settings/applications`, {
      form: { name, scope: 'write:user,read:repository' },
      maxRedirects: 0,
    });
    if (created.status() !== 303) throw new Error(`forgejo-token-create:${created.status()}`);
    createdToken = true;
    await page.goto(`${origin}/user/settings/applications`, { waitUntil: 'domcontentloaded' });
    const match = (await page.locator('.flash-info').innerText()).match(/\b[a-f0-9]{40}\b/i);
    if (!match) throw new Error('forgejo-token-missing');
    return await action(match[0]);
  } finally {
    if (createdToken) {
      const row = page.locator('.flex-item').filter({ has: page.locator('.flex-item-title', { hasText: name }) }).first();
      const id = await row.locator('button[data-modal-id="delete-token"]').getAttribute('data-id').catch(() => null);
      if (id) {
        const deleted = await context.request.post(`${origin}/user/settings/applications/delete`, { form: { id } });
        if (!deleted.ok()) process.stderr.write(`[android-native] forgejo-token-cleanup=${deleted.status()}\n`);
      } else {
        process.stderr.write('[android-native] forgejo-token-cleanup=missing-id\n');
      }
    }
    await browser.close();
  }
}
