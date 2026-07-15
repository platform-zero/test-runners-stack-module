import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { rootUrl, serviceUrl, stackDomain } from './stack-urls';

export type RouteKind = 'public' | 'forward_auth' | 'oidc_login' | 'non_ui' | 'orphaned';

export type AnonymousContract =
  | { kind: 'public_page'; matcher: RegExp; path?: string }
  | { kind: 'forward_auth'; path?: string }
  | { kind: 'service_login'; matcher: RegExp; loginLabel?: string; path?: string; allowAuthRedirect?: boolean }
  | { kind: 'canonical_redirect'; targetHost: 'apex' | string; followup: 'forward_auth' | 'public_page'; matcher?: RegExp; path?: string }
  | { kind: 'non_ui'; reason: string }
  | { kind: 'orphaned'; reason: string };

export type SmokeContract = {
  matcher: RegExp;
  path?: string;
  pathForUser?: (user: { username: string; email: string }) => string;
  selector?: string;
  loginLabel?: string;
  disallowMatcher?: RegExp;
  disallowUrlMatcher?: RegExp;
  headers?: Record<string, string>;
  oidcStartPath?: string;
};

export type VisualContract = SmokeContract & {
  fileStem: string;
  fullPage?: boolean;
  quality?: number;
  maxDarkPixelRatio?: number;
  prepare?: (page: Page) => Promise<void>;
};

export type BrowserRoute = {
  host: string;
  label: string;
  kind: RouteKind;
  path?: string;
  anonymous: AnonymousContract;
  smoke?: SmokeContract;
  visual?: VisualContract;
  ownership: {
    route: boolean;
    smoke: boolean;
    visual: boolean;
    deep: boolean;
  };
};

function resolveCaddyHostsPath(): string {
  const candidates = [
    process.env.CADDY_HOSTS_FILE,
    '/app/repo-fixtures/caddy-hosts.txt',
    path.resolve(process.cwd(), '../fixtures/caddy-hosts.txt'),
    path.resolve(__dirname, '../../fixtures/caddy-hosts.txt'),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim().length > 0));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to locate caddy-hosts.txt for Playwright route catalog validation.');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readCaddyHostsInventory(): string[] {
  return fs
    .readFileSync(resolveCaddyHostsPath(), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export const browserRouteCatalog: BrowserRoute[] = [
  {
    host: 'apex',
    label: 'Apex Portal',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /Datamancy|Keycloak|Grafana|BookStack/i,
      selector: 'text=/Datamancy|Keycloak|Grafana|BookStack/i',
      disallowMatcher: /\bSign in to your account\b|\b503 Service Unavailable\b/i,
    },
    visual: {
      fileStem: 'apex-portal-authenticated',
      matcher: /Datamancy|Keycloak|Grafana|BookStack/i,
      selector: 'text=/Datamancy|Keycloak|Grafana|BookStack/i',
      disallowMatcher: /\bSign in to your account\b|\b503 Service Unavailable\b/i,
      quality: 85,
      fullPage: true,
    },
    ownership: { route: true, smoke: true, visual: true, deep: false },
  },
  {
    host: 'onboarding',
    label: 'Account Onboarding',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /Finish account setup in Keycloak|Account setup complete|Open Keycloak Account Console|admin-managed/i,
      selector: 'text=/Finish account setup in Keycloak|Account setup complete|Open Keycloak Account Console|admin-managed/i',
      disallowMatcher: /\bSign in to your account\b|\b503 Service Unavailable\b/i,
    },
    visual: {
      fileStem: 'onboarding-authenticated',
      matcher: /Finish account setup in Keycloak|Account setup complete|Open Keycloak Account Console|admin-managed/i,
      selector: 'text=/Finish account setup in Keycloak|Account setup complete|Open Keycloak Account Console|admin-managed/i',
      disallowMatcher: /\bSign in to your account\b|\b503 Service Unavailable\b/i,
      quality: 85,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'alerts',
    label: 'Alertmanager',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /\bAlertmanager\b|\bAlerts\b|\bSilences\b|\bReceivers\b|\bStatus\b/i,
      selector: 'text=/Alertmanager|Alerts|Silences|Receivers|Status/i',
    },
    visual: {
      fileStem: 'alertmanager-authenticated',
      matcher: /\bAlertmanager\b|\bAlerts\b|\bSilences\b|\bReceivers\b|\bStatus\b/i,
      selector: 'text=/Alertmanager|Alerts|Silences|Receivers|Status/i',
      quality: 85,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'bookstack',
    label: 'BookStack',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /(?=.*(?:\bBookStack\b|\bdatamancy\b))(?=.*(?:Log in with Keycloak|\bLog In\b|\bLogin\b))/is, loginLabel: 'Keycloak', allowAuthRedirect: true, path: '/login' },
    smoke: {
      path: '/books',
      matcher: /\bBooks\b|\bShelves\b|Recently (Created|Updated)|My Recently Viewed|Recent Activity|Recently Updated Pages/i,
      selector: 'a[href="/books"], a[href="/shelves"], a[href$="/create-book"], .entity-list-item, text=/Books|Knowledge|Procedural Docs/i',
      loginLabel: 'Keycloak',
      disallowMatcher: /\bLog In\b|Log in with Keycloak/i,
      disallowUrlMatcher: /\/login\b/i,
    },
    visual: {
      fileStem: 'bookstack-authenticated',
      path: '/books',
      matcher: /\bBooks\b|\bShelves\b|Recently (Created|Updated)|My Recently Viewed|Recent Activity|Recently Updated Pages/i,
      selector: 'a[href="/books"], a[href="/shelves"], a[href$="/create-book"], .entity-list-item, text=/Books|Knowledge|Procedural Docs/i',
      loginLabel: 'Keycloak',
      disallowMatcher: /\bLog In\b|Log in with Keycloak/i,
      disallowUrlMatcher: /\/login\b/i,
      quality: 85,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'sogo',
    label: 'SOGo',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /\bSOGo\b|\bKeycloak\b|\bLogin\b|\bSign in\b/i, loginLabel: 'Keycloak', allowAuthRedirect: true, path: '/SOGo/' },
    visual: {
      path: '/SOGo/',
      fileStem: 'sogo-authenticated',
      matcher: /\bCalendar\b|\bMail\b|\bInbox\b|\bSent\b|\bDrafts\b|\bTrash\b/i,
      loginLabel: 'Keycloak',
      oidcStartPath: '/SOGo/',
      disallowUrlMatcher: /keycloak|keycloak-auth/i,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
    },
    ownership: { route: true, smoke: false, visual: true, deep: true },
  },
  {
    host: 'jellyfin',
    label: 'Jellyfin',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /\bJellyfin\b|\bKeycloak\b|\bSign In\b|\bLogin\b/i, loginLabel: 'Keycloak', allowAuthRedirect: true },
    visual: {
      fileStem: 'jellyfin-authenticated',
      matcher: /\bJellyfin\b|\bStack Media\b|\bDashboard\b|\bHome\b|\bFavorites\b|\bLibraries\b/i,
      selector: 'text=/Jellyfin|Stack Media|Dashboard|Home|Favorites|Libraries/i',
      loginLabel: 'Keycloak',
      oidcStartPath: '/sso/OID/start/keycloak',
      disallowMatcher: /\bWelcome to Jellyfin\b|\bset up your server\b|\bPlease select your preferred language\b|\bNothing here\b|create a library|\b503 Service Unavailable\b/i,
    },
    ownership: { route: true, smoke: false, visual: true, deep: true },
  },
  {
    host: 'donetick',
    label: 'Donetick',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /\bDonetick\b|\bContinue with Keycloak\b/i, loginLabel: 'Keycloak', allowAuthRedirect: true },
    visual: {
      fileStem: 'donetick-authenticated',
      path: '/chores',
      matcher: /\bCalendar Overview\b/i,
      selector: 'text=/Calendar Overview/i',
      loginLabel: 'Keycloak',
      disallowMatcher: /\bContinue with Keycloak\b|\bSign in to your account\b|\bLoading\.\.\.|\btaking longer than usual\b|\b503 Service Unavailable\b/i,
      prepare: async (page) => {
        await page.evaluate(async () => {
          const token = window.localStorage.getItem('token');
          if (!token) {
            throw new Error('Donetick did not persist an access token after OIDC login');
          }

          const request = async (path: string, init: RequestInit = {}) => {
            const response = await fetch(path, {
              ...init,
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(init.headers || {}),
              },
            });
            const text = await response.text();
            if (!response.ok) {
              throw new Error(`Donetick fixture request ${init.method || 'GET'} ${path} returned ${response.status}: ${text.slice(0, 240)}`);
            }
            return text ? JSON.parse(text) : {};
          };

          const unwrapList = (value: unknown): Array<Record<string, unknown>> => {
            if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
            if (value && typeof value === 'object') {
              const record = value as Record<string, unknown>;
              for (const candidate of [record.res, record.projects, record.chores]) {
                if (Array.isArray(candidate)) return candidate as Array<Record<string, unknown>>;
              }
            }
            return [];
          };

          let projects = unwrapList(await request('/api/v1/projects'));
          let project = projects.find((candidate) => candidate.name === 'Northstar Portal Cleanup');
          if (!project) {
            const created = await request('/api/v1/projects', {
              method: 'POST',
              body: JSON.stringify({
                name: 'Northstar Portal Cleanup',
                description: 'Delivery project for deterministic stack visual evidence.',
                color: '#06b6d4',
                icon: 'construction',
              }),
            });
            projects = unwrapList(created);
            project = projects[0]
              || (created && typeof created === 'object' ? (created as Record<string, unknown>).res as Record<string, unknown> : undefined);
          }
          const projectId = Number(project?.id);
          if (!Number.isInteger(projectId) || projectId <= 0) {
            throw new Error(`Donetick fixture project did not return a valid id: ${JSON.stringify(project)}`);
          }

          const chores = unwrapList(await request('/api/v1/chores'));
          for (const name of ['Verify backup restore drill', 'Update operator runbook']) {
            if (chores.some((candidate) => candidate.name === name)) continue;
            await request('/api/v1/chores', {
              method: 'POST',
              body: JSON.stringify({
                name,
                description: 'Seeded operational work used by the local visual contract.',
                projectId,
                assignStrategy: 'no_assignee',
                frequencyType: 'once',
                frequency: 1,
                isActive: true,
                dueDate: '2026-07-20T09:00:00Z',
              }),
            });
          }
        });

        await page.goto(new URL('/projects', page.url()).toString(), { waitUntil: 'domcontentloaded' });
        await page.getByText('Northstar Portal Cleanup', { exact: true }).first().click();
        await page.getByText('Verify backup restore drill', { exact: true }).waitFor({ timeout: 15000 });
        await page.getByText('Update operator runbook', { exact: true }).waitFor({ timeout: 15000 });
      },
    },
    ownership: { route: true, smoke: false, visual: true, deep: true },
  },
  {
    host: 'huly',
    label: 'Huly',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    ownership: { route: false, smoke: false, visual: false, deep: false },
  },
  {
    host: 'erpnext',
    label: 'ERPNext',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /\bERPNext\b|\bFrappe\b|\bKeycloak\b|\bLogin\b/i, loginLabel: 'Keycloak', allowAuthRedirect: true },
    visual: {
      fileStem: 'erpnext-authenticated',
      path: '/app/supplier/Northstar%20Hosting',
      matcher: /\bNorthstar Hosting\b/i,
      selector: 'text=/Northstar Hosting/i',
      loginLabel: 'Keycloak',
      disallowMatcher: /\bLogin to Frappe\b|\bEmail Address\b|\bEdit Profile\b|\bReset Password\b|\bManage 3rd party apps\b|\bPublic Profile\b|\bUser visibility\b|\bNot Found\b|\bDoes Not Exist\b|\b503 Service Unavailable\b/i,
      prepare: async (page) => {
        const gettingStartedPanel = page.locator('.onb-panel').filter({ hasText: 'Getting Started' }).first();
        if (!(await gettingStartedPanel.isVisible().catch(() => false))) {
          return;
        }

        await gettingStartedPanel.locator('.onb-header-actions button').last().click();
        await gettingStartedPanel.waitFor({ state: 'hidden', timeout: 5000 });
      },
    },
    ownership: { route: true, smoke: false, visual: true, deep: true },
  },
  {
    host: 'clickhouse',
    label: 'ClickHouse HTTP API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'HTTP API endpoint, not a human browser surface.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'element',
    label: 'Element',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /\bElement\b/i, loginLabel: 'Keycloak', allowAuthRedirect: true },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'api.element',
    label: 'Element Bootstrap API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Element client bootstrap endpoint, not a human browser surface.' },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'forgejo',
    label: 'Forgejo',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /(?=.*\bForgejo\b)(?=.*(?:Sign in with Keycloak|Sign In|Sign in))/is, loginLabel: 'Keycloak', allowAuthRedirect: true },
    smoke: {
      path: '/user/settings',
      matcher: /Account|Profile|Full name|Email Address|Dashboard|Your Repositories|New Repository|Issues|Pull Requests|Organizations/i,
      selector: 'input[name="full_name"], input#full_name, a[href="/repo/create"], .dashboard, a[href="/issues"], a[href="/pulls"]',
      loginLabel: 'Keycloak',
      disallowMatcher: /\bSign in\b|A painless, self-hosted Git service|Easy to install|Cross-platform|Lightweight|Open Source/i,
      disallowUrlMatcher: /\/user\/login\b/i,
    },
    visual: {
      fileStem: 'forgejo-authenticated',
      path: '/user/settings',
      matcher: /Account|Profile|Full name|Email Address|Dashboard|Your Repositories|New Repository|Issues|Pull Requests|Organizations/i,
      selector: 'input[name="full_name"], input#full_name, a[href="/repo/create"], .dashboard, a[href="/issues"], a[href="/pulls"]',
      loginLabel: 'Keycloak',
      disallowMatcher: /\bSign in\b|A painless, self-hosted Git service|Easy to install|Cross-platform|Lightweight|Open Source/i,
      disallowUrlMatcher: /\/user\/login\b/i,
      quality: 85,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'grafana',
    label: 'Grafana',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      path: '/d/logs-home/logs',
      selector: 'text=/All Logs|Dashboards|Refresh/i',
      matcher: /(?=[\s\S]*\bAll Logs\b)(?=[\s\S]*\b\d{4}-\d{2}-\d{2}\b)/i,
      disallowMatcher: /Data source error|Failed to load/i,
    },
    visual: {
      fileStem: 'grafana-authenticated',
      path: '/d/logs-home/logs',
      selector: 'text=/All Logs|Dashboards|Refresh/i',
      matcher: /(?=[\s\S]*\bAll Logs\b)(?=[\s\S]*\b\d{4}-\d{2}-\d{2}\b)/i,
      disallowMatcher: /Data source error|Failed to load/i,
      quality: 85,
      fullPage: false,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'homeassistant',
    label: 'Home Assistant',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /Overview|Developer Tools|History|Logbook|Automations|Devices|Areas|Integrations|Energy|Settings|Map|Media/i,
      selector: 'text=/Overview|Developer tools|Settings/i',
      disallowMatcher: /Home Assistant\s+Login|Trusted Networks|select a user|please select a user|forgot password\?|keep me logged in|^log in$/im,
      disallowUrlMatcher: /keycloak|keycloak-auth|\/auth\/(authorize|login_flow|login)/i,
    },
    ownership: { route: true, smoke: true, visual: false, deep: false },
  },
  {
    host: 'direct.homeassistant',
    label: 'Home Assistant Direct',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Direct device endpoint protected by Home Assistant native auth.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'portal',
    label: 'Homepage Dashboard',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /Datamancy|Keycloak|Grafana|BookStack/i,
      selector: 'text=/Datamancy|Keycloak|Grafana|BookStack/i',
      disallowMatcher: /\bSign in to your account\b|\b503 Service Unavailable\b/i,
    },
    visual: {
      fileStem: 'portal-authenticated',
      matcher: /Datamancy|Keycloak|Grafana|BookStack/i,
      selector: 'text=/Datamancy|Keycloak|Grafana|BookStack/i',
      disallowMatcher: /\bSign in to your account\b|\b503 Service Unavailable\b/i,
      quality: 85,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'homepage',
    label: 'Homepage Compatibility Redirect',
    kind: 'public',
    anonymous: { kind: 'canonical_redirect', targetHost: 'portal', followup: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'keycloak',
    label: 'Keycloak Portal',
    kind: 'non_ui',
    anonymous: {
      kind: 'non_ui',
      reason: 'Identity provider host; covered by Keycloak OIDC smoke tests.',
    },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'keycloak-auth',
    label: 'Keycloak Auth Gateway',
    kind: 'non_ui',
    anonymous: {
      kind: 'non_ui',
      reason: 'OAuth2 Proxy gateway endpoints are covered by Keycloak OIDC smoke tests.',
    },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'keycloak-whoami',
    label: 'Keycloak Protected Whoami',
    kind: 'non_ui',
    anonymous: {
      kind: 'non_ui',
      reason: 'Synthetic Keycloak-protected route is covered by Keycloak OIDC smoke tests.',
    },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'jupyterhub',
    label: 'JupyterHub',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth', path: '/user-redirect/lab' },
    path: '/user-redirect/lab',
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'kopia',
    label: 'Kopia',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'mail',
    label: 'Mail Host',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Certificate/SMTP host, not a web UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'mastodon',
    label: 'Mastodon',
    kind: 'oidc_login',
    anonymous: { kind: 'public_page', matcher: /\bMastodon\b|To use the Mastodon web application, please enable JavaScript/i },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'matrix',
    label: 'Matrix API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Matrix client-server/federation API surface.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'matrix-rtc',
    label: 'MatrixRTC Backend',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'MatrixRTC LiveKit signaling and JWT API surface.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'models',
    label: 'Embedding API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Embedding API endpoint, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'ntfy',
    label: 'ntfy',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'onlyoffice',
    label: 'OnlyOffice Stub',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Seafile integration endpoint, not a standalone user UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'pipeline',
    label: 'Pipeline Monitor',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /\bAirflow\b|\bDAGs\b|\bPipeline Readiness\b|\bSources\b|\bStatus\b|\bData Pipeline\b/i,
      selector: 'text=/Airflow|DAGs|Pipeline Readiness|Sources|Status|Data Pipeline/i',
    },
    visual: {
      fileStem: 'pipeline-monitor-authenticated',
      matcher: /\bAirflow\b|\bDAGs\b|\bPipeline Readiness\b|\bSources\b|\bStatus\b|\bData Pipeline\b/i,
      selector: 'text=/Airflow|DAGs|Pipeline Readiness|Sources|Status|Data Pipeline/i',
      disallowMatcher: /\bLog In\b|\bSign in to your account\b|\b503 Service Unavailable\b/i,
      quality: 85,
    },
    ownership: { route: true, smoke: true, visual: true, deep: true },
  },
  {
    host: 'planka',
    label: 'Planka',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /(?=.*\bPlanka\b)(?=.*(?:Log in with SSO|OIDC|Keycloak|\bLog in\b))/is, loginLabel: 'Keycloak', allowAuthRedirect: true, path: '/login' },
    path: '/login',
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'prometheus',
    label: 'Prometheus',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'search',
    label: 'OpenSearch',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /cluster_name|opensearch|You Know, for Search/i,
      selector: 'body',
      disallowMatcher: /Sign in|Log in|Keycloak|Bad Gateway|Service Unavailable|Internal Server Error/i,
      disallowUrlMatcher: /keycloak|keycloak-auth/i,
    },
    ownership: { route: true, smoke: true, visual: false, deep: true },
  },
  {
    host: 'websearch',
    label: 'SearXNG',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /SearXNG|Webservices Search|Search/i,
      selector: 'form[action="/search"], input[name="q"], body',
      disallowMatcher: /Sign in|Log in|Keycloak|Bad Gateway|Service Unavailable|Internal Server Error/i,
      disallowUrlMatcher: /keycloak|keycloak-auth/i,
    },
    ownership: { route: true, smoke: true, visual: false, deep: true },
  },
  {
    host: 'spawner',
    label: 'Workload Spawner',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    smoke: {
      matcher: /Workload Spawner|instances|templates|spawner/i,
      selector: 'body',
      disallowMatcher: /Sign in|Log in|Keycloak|Bad Gateway|Service Unavailable|Internal Server Error/i,
      disallowUrlMatcher: /keycloak|keycloak-auth/i,
    },
    ownership: { route: true, smoke: true, visual: false, deep: true },
  },
  {
    host: '*.apps',
    label: 'Workload Apps Wildcard',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'seafile',
    label: 'Seafile',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'vaultwarden',
    label: 'Vaultwarden',
    kind: 'oidc_login',
    anonymous: { kind: 'service_login', matcher: /(?=.*(?:Vaultwarden|Bitwarden|Web Vault))(?=.*(?:Single sign-on|Use single sign-on|SSO|Log in))/is, loginLabel: 'Single sign-on', allowAuthRedirect: true },
    ownership: { route: true, smoke: false, visual: false, deep: true },
  },
  {
    host: 'www',
    label: 'WWW Redirect',
    kind: 'public',
    anonymous: { kind: 'canonical_redirect', targetHost: 'apex', followup: 'forward_auth' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'api.bookstack',
    label: 'BookStack API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Token/API surface, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'api.homeassistant',
    label: 'Home Assistant API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'API surface, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'api.matrix',
    label: 'Matrix API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'API surface, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'api.seafile',
    label: 'Seafile API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Token/API surface, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'api.vaultwarden',
    label: 'Vaultwarden API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Bitwarden native API endpoint, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'api.mastodon',
    label: 'Mastodon API',
    kind: 'non_ui',
    anonymous: { kind: 'non_ui', reason: 'Mastodon native app/API endpoint, not a browser UI.' },
    ownership: { route: true, smoke: false, visual: false, deep: false },
  },
  {
    host: 'qbittorrent',
    label: 'qBittorrent',
    kind: 'forward_auth',
    anonymous: { kind: 'forward_auth' },
    visual: {
      fileStem: 'qbittorrent-authenticated',
      matcher: /northstar-portal-backup\.iso/i,
      selector: 'text=northstar-portal-backup.iso',
      disallowMatcher: /\bUsername\b|\bPassword\b|\bLogin\b|\bSign in to your account\b|\b503 Service Unavailable\b/i,
      prepare: async (page) => {
        // qBittorrent initially marks the document dark to suppress a bright
        // startup flash, then removes that marker after loading the configured
        // light theme. Do not capture the intermediate mixed-theme repaint.
        await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
        // The pointer starts over qBittorrent's File menu, whose hover state
        // expands over the transfer list. Move it into neutral content and
        // require the transient menu to close before capturing evidence.
        await page.mouse.move(800, 250);
        await page.keyboard.press('Escape');
        await page.locator('#desktopNavbar li ul').evaluateAll((menus) => {
          for (const menu of menus) {
            (menu as HTMLElement).style.setProperty('left', '-999em', 'important');
          }
        });
        await page.waitForFunction(() => {
          const menu = document.querySelector<HTMLElement>('#desktopNavbar > ul > li:first-child > ul');
          return menu === null || menu.getBoundingClientRect().right <= 0;
        });
      },
      maxDarkPixelRatio: 0.2,
      quality: 85,
    },
    ownership: { route: true, smoke: false, visual: true, deep: false },
  },
];

export function routeUrl(route: BrowserRoute, overridePath?: string): string {
  const targetPath = overridePath ?? route.path ?? '/';
  if (route.host === 'apex') {
    return rootUrl(targetPath);
  }
  if (route.host === 'www') {
    return `https://www.${stackDomain}${targetPath}`;
  }
  return serviceUrl(route.host, targetPath);
}

export function routeUrlPattern(host: string): RegExp {
  if (host === 'apex') {
    return new RegExp(`^https://(?:www\\.)?${escapeRegex(stackDomain)}(?:/|$)`, 'i');
  }

  return new RegExp(`^https://${escapeRegex(host)}\\.${escapeRegex(stackDomain)}(?:/|$)`, 'i');
}

export function findRoute(host: string): BrowserRoute {
  const route = browserRouteCatalog.find((candidate) => candidate.host === host);
  if (!route) {
    throw new Error(`No route catalog entry exists for host '${host}'.`);
  }
  return route;
}

function selectedRouteHosts(): Set<string> | null {
  const raw = process.env.PLAYWRIGHT_ROUTE_HOSTS || '';
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? new Set(hosts) : null;
}

function selectedComponents(): Set<string> | null {
  const candidates = [
    process.env.TEST_RUNNER_COMPONENTS_LOCK_FILE,
    process.env.WEBSERVICES_COMPONENTS_LOCK_FILE,
    '/component-lock/components.lock.json',
    '/runtime/components.lock.json',
    '/app/build/site/components.lock.json',
    '/app/site/components.lock.json',
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim().length > 0));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { components?: unknown };
      if (Array.isArray(parsed.components)) {
        return new Set(parsed.components.filter((component): component is string => typeof component === 'string'));
      }
    } catch {
      return null;
    }
  }

  return null;
}

const optionalRouteComponents: Record<string, string> = {
  clickhouse: 'clickhouse',
  huly: 'huly',
  jupyterhub: 'jupyterhub',
  'api.matrix': 'synapse',
  matrix: 'synapse',
  'matrix-rtc': 'synapse',
  models: 'inference',
  pipeline: 'pipeline',
  search: 'search',
  websearch: 'searxng',
  spawner: 'workload-spawner',
  '*.apps': 'workload-spawner',
};

export function isRuntimeExcluded(route: BrowserRoute): boolean {
  if (process.env.TESTDEV_SKIP_GPU_INGESTION === '1' && route.host === 'pipeline') {
    return true;
  }
  const requiredComponent = optionalRouteComponents[route.host];
  const components = selectedComponents();
  if (requiredComponent && components !== null && !components.has(requiredComponent)) {
    return true;
  }
  const selectedHosts = selectedRouteHosts();
  return selectedHosts !== null && !selectedHosts.has(route.host);
}

export const routeContractRoutes = browserRouteCatalog.filter((route) => route.ownership.route && !isRuntimeExcluded(route));
export const smokeRoutes = browserRouteCatalog.filter((route) => route.ownership.smoke && !isRuntimeExcluded(route));
export const visualRoutes = browserRouteCatalog.filter((route) => route.ownership.visual && !isRuntimeExcluded(route));
export const mobileSmokeRoutes = smokeRoutes.filter((route) =>
  new Set(['apex', 'onboarding', 'bookstack', 'forgejo', 'grafana', 'homeassistant']).has(route.host)
);

export function uncataloguedHosts(): string[] {
  const cataloguedHosts = new Set(browserRouteCatalog.map((route) => route.host));
  return readCaddyHostsInventory().filter((host) => !cataloguedHosts.has(host));
}
