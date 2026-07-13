import { test, expect } from '@playwright/test';
import { stackDomain } from '../../../utils/stack-urls';

function caddyRouteUrl(path = '/'): string {
  return `${(process.env.CADDY_URL || '').replace(/\/$/, '') || `https://${stackDomain}`}${path}`;
}

function caddyHostHeaders(subdomain: string): Record<string, string> {
  return { Host: `${subdomain}.${stackDomain}` };
}

function assertNoBrowserSsoRedirect(location: string | null): void {
  const value = (location || '').toLowerCase();
  expect(value).not.toContain('keycloak');
  expect(value).not.toContain('/oauth2/start');
}

test.describe('Non-browser API endpoints', () => {
  test('Element bootstrap endpoint stays app-facing', async ({ request }) => {
    const response = await request.get(caddyRouteUrl('/config.json'), {
      headers: caddyHostHeaders('api.element'),
      maxRedirects: 0,
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty('default_server_config');
  });

  test('Seafile API endpoint does not redirect to browser SSO', async ({ request }) => {
    const response = await request.get(caddyRouteUrl('/api2/ping/'), {
      headers: caddyHostHeaders('api.seafile'),
      maxRedirects: 0,
    });
    expect([200, 401, 403]).toContain(response.status());
    assertNoBrowserSsoRedirect(response.headers()['location'] || null);
  });

  test('Vaultwarden API endpoint does not redirect to browser SSO', async ({ request }) => {
    const response = await request.get(caddyRouteUrl('/api/config'), {
      headers: caddyHostHeaders('api.vaultwarden'),
      maxRedirects: 0,
    });
    expect([200, 401, 403]).toContain(response.status());
    assertNoBrowserSsoRedirect(response.headers()['location'] || null);
  });

  test('Mastodon app API endpoint does not redirect to browser SSO', async ({ request }) => {
    const response = await request.get(caddyRouteUrl('/api/v1/instance'), {
      headers: caddyHostHeaders('api.mastodon'),
      maxRedirects: 0,
    });
    expect([200, 401, 403]).toContain(response.status());
    assertNoBrowserSsoRedirect(response.headers()['location'] || null);
  });

  test('Home Assistant API endpoint does not redirect to browser SSO', async ({ request }) => {
    const response = await request.get(caddyRouteUrl('/api/'), {
      headers: caddyHostHeaders('api.homeassistant'),
      maxRedirects: 0,
    });
    expect([200, 401, 403]).toContain(response.status());
    assertNoBrowserSsoRedirect(response.headers()['location'] || null);
  });
});
