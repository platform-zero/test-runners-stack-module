import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { serviceUrl } from '../../../utils/stack-urls';
import {
  domain,
  escapeRegex,
  normalizedString,
  testOIDCService,
} from './oidc';

export type MatrixSession = {
  userId: string;
  accessToken: string;
  homeserverUrl: string;
};

type MatrixLoginResponse = {
  access_token?: string;
  user_id?: string;
  home_server?: string;
  well_known?: {
    'm.homeserver'?: {
      base_url?: string;
    };
  };
};

const homeserverUrl = `https://matrix.${domain}`;

async function readElementMatrixSession(page: Page): Promise<MatrixSession & { snapshot: Record<string, string> }> {
  return page.evaluate(() => {
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      snapshot[key] = window.localStorage.getItem(key) || '';
    }

    return {
      userId: snapshot.mx_user_id || snapshot.mx_userid || '',
      accessToken: snapshot.mx_access_token || '',
      homeserverUrl: snapshot.mx_hs_url || '',
      snapshot,
    };
  });
}

export async function loginElementMatrixSession(page: Page): Promise<MatrixSession> {
  let observedMatrixSession: Partial<MatrixSession> = {};
  const matrixLoginSessionPromise = page.waitForResponse(
    (response) => {
      const request = response.request();
      return request.method() === 'POST'
        && response.ok()
        && /\/_matrix\/client\/(?:v3|r0)\/login(?:\?|$)/.test(response.url());
    },
    { timeout: 180000 },
  ).then(async (response) => {
    const payload = await response.json().catch(() => ({})) as MatrixLoginResponse;
    const accessToken = normalizedString(payload.access_token);
    const userId = normalizedString(payload.user_id);
    const responseHomeserver =
      normalizedString(payload.well_known?.['m.homeserver']?.base_url)
      || (normalizedString(payload.home_server) ? `https://${normalizedString(payload.home_server)}` : '')
      || homeserverUrl;

    if (accessToken) {
      observedMatrixSession = {
        accessToken,
        userId,
        homeserverUrl: responseHomeserver,
      };
    }

    return observedMatrixSession;
  }).catch(() => null);

  await testOIDCService(
    page,
    'Element (Matrix Web)',
    serviceUrl('element'),
    /All rooms|Home|People|Rooms|Explore|Settings|Chats|Start chat|Recents|Room|Start a chat|Create a room|People|Setting up keys/i,
    ['Keycloak', 'Continue with Keycloak SSO', 'Continue with SSO', 'SSO', 'Single sign-on', 'Sign in with SSO'],
    {
      disallowPatterns: [/Welcome to Element/i, /Sign in/i, /Create Account/i],
      disallowUrlPatterns: [/#\/welcome\b/i, /#\/login\b/i],
      loginPath: serviceUrl('element', '/#/login'),
      loginButtonPatterns: [/sign in|log in|continue with keycloak sso|continue with sso|sso|openid/i],
      oidcLinkPatterns: [/continue with keycloak sso/i, /sign in with sso/i, /sso/i, /single sign-on/i, /keycloak/i],
      authenticatedRecoveryPath: serviceUrl('element'),
      authenticatedProbe: async (page) => {
        const state = await page.evaluate(() => {
          const snapshot: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i += 1) {
            const key = window.localStorage.key(i);
            if (!key) continue;
            snapshot[key] = window.localStorage.getItem(key) || '';
          }

          return {
            userId: snapshot.mx_user_id || snapshot.mx_userid || '',
            homeserverUrl: snapshot.mx_hs_url || '',
            hasAccessToken: snapshot.mx_has_access_token === 'true' || Boolean(snapshot.mx_access_token),
            href: window.location.href,
            bodyText: document.body?.innerText || '',
          };
        }).catch(() => ({
          userId: '',
          homeserverUrl: '',
          hasAccessToken: false,
          href: '',
          bodyText: '',
        }));
        const loginShell = /#\/(?:login|welcome)\b/i.test(state.href)
          || /Sign in\s+Homeserver|New here\?|Welcome to Element/i.test(state.bodyText);
        if (loginShell) {
          return false;
        }

        return Boolean(
          (state.userId && state.homeserverUrl)
          || state.hasAccessToken
          || /\b(All rooms|People|Rooms|Explore|Settings|Chats|Start chat|Recents|Create a room|Setting up keys|Verify this device)\b|Are you sure\?/i.test(state.bodyText)
        );
      },
      uiPatternOverride: /Matrix ID|All rooms|People|Rooms|Explore|Settings|Chats|Start chat|Recents|Start a chat|Create a room|Setting up keys/i,
      screenshotFullPage: false,
      preLogin: async (page) => {
        const signInLink = page.getByRole('link', { name: /sign in/i }).first();
        const signInButton = page.getByRole('button', { name: /sign in/i }).first();
        if (await signInLink.isVisible().catch(() => false)) {
          await signInLink.click({ force: true });
          await page.waitForTimeout(1000);
        } else if (await signInButton.isVisible().catch(() => false)) {
          await signInButton.click({ force: true });
          await page.waitForTimeout(1000);
        }

        const homeserverInput = page.locator(
          'input[placeholder*="matrix"], input[name*="home"], input[id*="home"]'
        ).first();
        const continueButton = page.getByRole('button', { name: /continue|next|submit/i }).first();
        if (await homeserverInput.isVisible().catch(() => false)) {
          const currentValue = await homeserverInput.inputValue().catch(() => '');
          if (!currentValue) {
            await homeserverInput.fill(homeserverUrl);
          }
          if (await continueButton.isVisible().catch(() => false)) {
            await continueButton.click({ force: true });
          } else {
            await homeserverInput.press('Enter').catch(() => {});
          }
          await page.waitForTimeout(1500);
        }

        const keycloakSsoButton = page.getByRole('button', { name: /continue with keycloak sso/i }).first();
        await keycloakSsoButton.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        if (await keycloakSsoButton.isVisible().catch(() => false)) {
          await keycloakSsoButton.click({ force: true, noWaitAfter: true });
          await page.waitForURL(
            (url) => /keycloak|keycloak-auth/.test(url.toString()),
            { timeout: 15000 }
          ).catch(() => {});
          return;
        }

        const anySsoButton = page.getByRole('button', {
          name: /sign in with sso|continue with sso|single sign-on|sso/i,
        }).or(
          page.getByRole('link', {
            name: /sign in with sso|continue with sso|single sign-on|sso/i,
          })
        ).first();
        await anySsoButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await anySsoButton.isVisible().catch(() => false)) {
          await anySsoButton.click({ force: true, noWaitAfter: true });
          await page.waitForURL(
            (url) => /keycloak|keycloak-auth/.test(url.toString()),
            { timeout: 15000 }
          ).catch(() => {});
        }
      },
      postLogin: async (page) => {
        const masCreateAccountButton = page.getByRole('button', { name: /create account/i }).first();
        const masImportHeading = page.getByRole('heading', { name: /import your data/i }).first();
        await masImportHeading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await masCreateAccountButton.isVisible().catch(() => false)) {
          await masCreateAccountButton.click({ force: true });
          await page.waitForURL(
            (url) => !url.toString().includes('/upstream/link/'),
            { timeout: 60000 }
          ).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }

        const masContinueButton = page.getByRole('button', { name: /^continue$/i }).first();
        const masContinueHeading = page.getByRole('heading', { name: /continue to element\./i }).first();
        await masContinueHeading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await masContinueButton.isVisible().catch(() => false)) {
          await masContinueButton.click({ force: true });
          await page.waitForURL(
            (url) => /element\./i.test(url.hostname) || url.toString().includes('loginToken='),
            { timeout: 60000 }
          ).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }

        if (page.url().includes('loginToken=')) {
          const progress = page.getByRole('progressbar').first();
          if (await progress.isVisible().catch(() => false)) {
            await progress.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
          }
          await page.waitForURL(
            (url) => !url.toString().includes('loginToken='),
            { timeout: 60000 }
          ).catch(() => {});
        }

        const setupKeysDialog = page.locator('text=/setting up keys/i').first();
        if (await setupKeysDialog.isVisible().catch(() => false)) {
          await setupKeysDialog.waitFor({ state: 'hidden', timeout: 90000 }).catch(() => {});
          await page.waitForTimeout(1500);
        }

        const verifyLaterButton = page.getByRole('button', { name: /i'?ll verify later|verify later/i }).first();
        const areYouSureHeading = page.locator('text=/are you sure\\?/i').first();
        await areYouSureHeading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if ((await areYouSureHeading.isVisible().catch(() => false)) || (await verifyLaterButton.isVisible().catch(() => false))) {
          if (await verifyLaterButton.isVisible().catch(() => false)) {
            await verifyLaterButton.click({ force: true }).catch(() => {});
          } else {
            const goBackButton = page.getByRole('button', { name: /go back/i }).first();
            if (await goBackButton.isVisible().catch(() => false)) {
              await goBackButton.click({ force: true }).catch(() => {});
            } else {
              await page.keyboard.press('Escape').catch(() => {});
            }
          }
          await page.waitForTimeout(1500);
        }

        const verifyHeading = page.locator('text=/verify this device/i').first();
        await verifyHeading.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        if (await verifyHeading.isVisible().catch(() => false)) {
          const skipButton = page.getByRole('button', { name: /skip verification/i }).first();
          if (await skipButton.isVisible().catch(() => false)) {
            await skipButton.click({ force: true }).catch(() => {});
            await page.waitForTimeout(1500);
          } else {
            const closeButton = page.locator(
              'button[aria-label="Close"], button[aria-label="Close dialog"], button:has-text("Close")'
            ).first();
            if (await closeButton.isVisible().catch(() => false)) {
              await closeButton.click({ force: true }).catch(() => {});
            } else {
              await page.keyboard.press('Escape').catch(() => {});
            }
            await page.waitForTimeout(1500);
          }
        }

        const cleanupButtons = [
          page.getByRole('button', { name: /dismiss/i }).first(),
          page.getByRole('button', { name: /^ok$/i }).first(),
          page.getByRole('button', { name: /got it/i }).first(),
        ];
        for (const button of cleanupButtons) {
          if (await button.isVisible().catch(() => false)) {
            await button.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
          }
        }

        await expect.poll(
          async () => {
            const localSession = await readElementMatrixSession(page);
            return normalizedString(localSession.accessToken)
              || normalizedString(observedMatrixSession.accessToken);
          },
          { timeout: 90000, message: 'Element Matrix access token should be present after MAS SSO' },
        ).not.toBe('');
      },
    }
  );

  const session = await readElementMatrixSession(page);
  if (!session.accessToken) {
    await Promise.race([
      matrixLoginSessionPromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }

  let matrixUserId = session.userId || normalizedString(observedMatrixSession.userId);
  let matrixHomeserverUrl = session.homeserverUrl || normalizedString(observedMatrixSession.homeserverUrl);
  const matrixAccessToken = normalizedString(session.accessToken) || normalizedString(observedMatrixSession.accessToken);

  if (matrixAccessToken && (!matrixUserId || !matrixHomeserverUrl)) {
    const whoAmIResponse = await page.request.get(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
      headers: {
        Authorization: `Bearer ${matrixAccessToken}`,
      },
    });
    if (whoAmIResponse.ok()) {
      const whoAmI = await whoAmIResponse.json();
      matrixUserId = matrixUserId || whoAmI.user_id || '';
      matrixHomeserverUrl = matrixHomeserverUrl || homeserverUrl;
    }
  }

  if (!matrixAccessToken || !matrixUserId || !matrixHomeserverUrl) {
    const snapshotKeys = Object.keys(session.snapshot).sort().join(', ');
    throw new Error(`Element Matrix session data was incomplete. localStorage keys=${snapshotKeys}`);
  }

  const normalizeUrl = (value: string) => value.replace(/\/+$/, '');
  expect(normalizeUrl(matrixHomeserverUrl)).toBe(normalizeUrl(homeserverUrl));
  expect(matrixUserId).toMatch(new RegExp(`:matrix\\.${escapeRegex(domain)}$`, 'i'));

  return {
    userId: matrixUserId,
    accessToken: matrixAccessToken,
    homeserverUrl: matrixHomeserverUrl,
  };
}
