import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  browserRouteCatalog,
  browserWuiHosts,
  browserWuiRoutes,
  findRoute,
  readCaddyHostsInventory,
  routeUrl,
  routeUrlPattern,
  smokeRoutes,
  mobileSmokeRoutes,
  uncataloguedHosts,
  visualRoutes,
} from '../../utils/route-catalog';

describe('route-catalog', () => {
  const originalHostsFile = process.env.CADDY_HOSTS_FILE;
  const originalComponentsLockFile = process.env.TEST_RUNNER_COMPONENTS_LOCK_FILE;

  afterEach(() => {
    if (originalHostsFile === undefined) {
      delete process.env.CADDY_HOSTS_FILE;
    } else {
      process.env.CADDY_HOSTS_FILE = originalHostsFile;
    }
    if (originalComponentsLockFile === undefined) {
      delete process.env.TEST_RUNNER_COMPONENTS_LOCK_FILE;
    } else {
      process.env.TEST_RUNNER_COMPONENTS_LOCK_FILE = originalComponentsLockFile;
    }
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('catalogues every Caddy host exactly once', () => {
    const inventory = readCaddyHostsInventory();
    const cataloguedHosts = browserRouteCatalog.map((route) => route.host);

    expect(new Set(cataloguedHosts).size).toBe(cataloguedHosts.length);
    expect(new Set(inventory).size).toBe(inventory.length);
    expect(uncataloguedHosts()).toEqual([]);
    expect([...cataloguedHosts].sort()).toEqual([...inventory].sort());
  });

  it('keeps non-browser and orphaned routes out of smoke and visual suites', () => {
    const invalidSmokeHosts = smokeRoutes.filter((route) => route.kind === 'non_ui' || route.kind === 'orphaned');
    const invalidVisualHosts = visualRoutes.filter((route) => route.kind === 'non_ui' || route.kind === 'orphaned');

    expect(invalidSmokeHosts).toEqual([]);
    expect(invalidVisualHosts).toEqual([]);
  });

  it('requires visual evidence for the independent WUI service inventory', () => {
    expect(browserWuiHosts).toEqual([
      'apex', 'onboarding', 'alerts', 'bookstack', 'sogo', 'jellyfin', 'donetick', 'huly',
      'erpnext', 'element', 'forgejo', 'grafana', 'homeassistant', 'portal', 'keycloak',
      'jupyterhub', 'kopia', 'mastodon', 'ntfy', 'pipeline', 'planka', 'prometheus',
      'websearch', 'seafile', 'vaultwarden', 'qbittorrent',
    ]);

    for (const route of browserWuiRoutes) {
      expect(route.ownership.route).toBe(true);
      expect(route.ownership.visual).toBe(true);
      expect(route.visual).toBeDefined();
      expect(route.visual?.fileStem).toMatch(/^[a-z0-9-]+$/);
      expect(route.visual?.matcher).toBeInstanceOf(RegExp);
    }

    expect(new Set(browserWuiRoutes.map((route) => route.visual?.fileStem)).size).toBe(browserWuiRoutes.length);
  });

  it('keeps mobile smoke coverage focused on mobile-critical browser services', () => {
    expect(mobileSmokeRoutes.map((route) => route.host).sort()).toEqual([
      'apex',
      'bookstack',
      'forgejo',
      'grafana',
      'homeassistant',
      'onboarding',
    ]);
  });

  it('classifies MatrixRTC as a non-UI LiveKit and JWT API route', () => {
    const matrixRtc = findRoute('matrix-rtc');

    expect(matrixRtc.kind).toBe('non_ui');
    expect(matrixRtc.anonymous).toMatchObject({
      kind: 'non_ui',
      reason: expect.stringMatching(/MatrixRTC.*LiveKit.*JWT/i),
    });
    expect(matrixRtc.smoke).toBeUndefined();
    expect(matrixRtc.visual).toBeUndefined();
  });

  it('builds route URLs for apex, www, and service hosts', () => {
    expect(routeUrl(findRoute('apex'))).toBe('https://datamancy.net/');
    expect(routeUrl(findRoute('grafana'), '/explore')).toBe('https://grafana.datamancy.net/explore');
    expect(routeUrl(findRoute('www'), '/docs')).toBe('https://www.datamancy.net/docs');
  });

  it('builds route URL patterns for apex and subdomains', () => {
    expect(routeUrlPattern('apex').test('https://datamancy.net/')).toBe(true);
    expect(routeUrlPattern('apex').test('https://www.datamancy.net/login')).toBe(true);
    expect(routeUrlPattern('grafana').test('https://grafana.datamancy.net/dashboards')).toBe(true);
    expect(routeUrlPattern('grafana').test('https://grafana.example.net/dashboards')).toBe(false);
  });

  it('finds known routes and throws for unknown hosts', () => {
    expect(findRoute('grafana')).toMatchObject({ host: 'grafana', label: 'Grafana' });
    expect(() => findRoute('missing-host')).toThrow("No route catalog entry exists for host 'missing-host'.");
  });

  it('uses Forgejo account settings as the stable authenticated smoke surface', () => {
    const forgejo = findRoute('forgejo');

    expect(forgejo.smoke).toMatchObject({
      path: '/user/settings',
      selector: 'input[name="full_name"], input#full_name, a[href="/repo/create"], .dashboard, a[href="/issues"], a[href="/pulls"]',
      disallowUrlMatcher: /\/user\/login\b/i,
    });
    expect(forgejo.smoke?.matcher.test('Account\nFull name\nEmail Address')).toBe(true);
    expect(forgejo.visual).toMatchObject({
      path: '/user/settings',
      disallowUrlMatcher: /\/user\/login\b/i,
    });
  });

  it('requires service-specific evidence for OIDC service login pages', () => {
    const genericLoginContent = 'Keycloak\nSign in\nLogin\nSingle sign-on\nSSO\nOpenID Connect';
    const oidcLoginHosts = ['bookstack', 'element', 'forgejo', 'planka', 'vaultwarden'];

    for (const host of oidcLoginHosts) {
      const route = findRoute(host);
      expect(route.anonymous.kind).toBe('service_login');
      if (route.anonymous.kind !== 'service_login') {
        continue;
      }

      expect(route.anonymous.matcher.test(genericLoginContent)).toBe(false);
    }
  });

  it('uses stable, populated visual targets for SOGo, Donetick, and ERPNext', () => {
    const sogo = findRoute('sogo');
    const donetick = findRoute('donetick');
    const erpnext = findRoute('erpnext');

    expect(sogo.visual?.pathForUser?.({
      username: 'pw-test',
      email: 'pw-test@datamancy.net',
    })).toBeUndefined();
    expect(sogo.visual?.path).toBe('/SOGo/');
    expect(sogo.visual?.selector).toBeUndefined();
    expect(sogo.visual?.matcher.test('Calendar | webservices Mail')).toBe(true);

    expect(donetick.visual?.path).toBe('/chores');
    expect(donetick.visual?.matcher.test('Calendar Overview')).toBe(true);
    expect(donetick.visual?.disallowMatcher?.test('Sign in to your account')).toBe(true);
    expect(donetick.visual?.disallowMatcher?.test('Loading... This is taking longer than usual.')).toBe(true);
    expect(donetick.visual?.prepare).toBeDefined();

    expect(erpnext.visual?.path).toBe('/app/supplier/Northstar%20Hosting');
    expect(erpnext.visual?.matcher.test('Framework Quality')).toBe(false);
    expect(erpnext.visual?.matcher.test('Northstar Hosting')).toBe(true);
    expect(erpnext.visual?.disallowMatcher?.test('Login to Frappe')).toBe(true);
    expect(erpnext.visual?.prepare).toBeDefined();
  });

  it('rejects empty Grafana logs and qBittorrent native-login false positives', () => {
    const grafana = findRoute('grafana');
    const qbittorrent = findRoute('qbittorrent');

    expect(grafana.visual?.matcher.test('All Logs 2026-07-15 18:50:42 INFO')).toBe(true);
    expect(grafana.visual?.matcher.test('All Logs No data')).toBe(false);
    expect(grafana.visual?.disallowMatcher?.test('No data')).toBe(false);
    expect(grafana.visual?.disallowMatcher?.test('Data source error')).toBe(true);
    expect(qbittorrent.visual?.matcher.test('qBittorrent WebUI Username Password Login')).toBe(false);
    expect(qbittorrent.visual?.disallowMatcher?.test('qBittorrent WebUI Username Password Login')).toBe(true);
    expect(qbittorrent.visual?.matcher.test('northstar-portal-backup.iso')).toBe(true);
    expect(qbittorrent.visual?.prepare).toBeDefined();
    expect(qbittorrent.visual?.maxDarkPixelRatio).toBe(0.05);
  });

  it('reads host inventory from an explicit file and strips comments', () => {
    const hostsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'route-catalog-')),
      'caddy-hosts.txt'
    );
    fs.writeFileSync(hostsFile, '# comment\napex\n\nsearch\n');
    process.env.CADDY_HOSTS_FILE = hostsFile;

    expect(readCaddyHostsInventory()).toEqual(['apex', 'search']);
  });

  it('reports uncatalogued hosts from the configured inventory file', () => {
    const hostsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'route-catalog-extra-')),
      'caddy-hosts.txt'
    );
    fs.writeFileSync(hostsFile, 'apex\ngrafana\nunknown-host\n');
    process.env.CADDY_HOSTS_FILE = hostsFile;

    expect(uncataloguedHosts()).toEqual(['unknown-host']);
  });

  it('excludes optional routes when their components are not selected', () => {
    const componentsLockFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'route-catalog-components-')),
      'components.lock.json'
    );
    fs.writeFileSync(componentsLockFile, JSON.stringify({ components: ['core', 'jupyterhub', 'observability'] }));
    process.env.TEST_RUNNER_COMPONENTS_LOCK_FILE = componentsLockFile;

    jest.isolateModules(() => {
      const isolatedModule = require('../../utils/route-catalog') as {
        routeContractRoutes: Array<{ host: string }>;
        visualRoutes: Array<{ host: string }>;
      };

      expect(isolatedModule.routeContractRoutes.map((route) => route.host)).not.toContain('models');
      expect(isolatedModule.routeContractRoutes.map((route) => route.host)).not.toContain('pipeline');
      expect(isolatedModule.visualRoutes.map((route) => route.host)).not.toContain('pipeline');
    });
  });

  it('throws when no caddy host inventory can be found', () => {
    const previousHostsFile = process.env.CADDY_HOSTS_FILE;

    jest.isolateModules(() => {
      delete process.env.CADDY_HOSTS_FILE;
      jest.doMock('fs', () => ({
        readFileSync: jest.fn(),
        existsSync: jest.fn(() => false),
      }));

      const isolatedModule = require('../../utils/route-catalog') as {
        readCaddyHostsInventory: () => string[];
      };

      expect(() => isolatedModule.readCaddyHostsInventory()).toThrow(
        'Unable to locate caddy-hosts.txt for Playwright route catalog validation.'
      );
    });

    if (previousHostsFile === undefined) {
      delete process.env.CADDY_HOSTS_FILE;
    } else {
      process.env.CADDY_HOSTS_FILE = previousHostsFile;
    }
    jest.dontMock('fs');
    jest.resetModules();
  });
});
