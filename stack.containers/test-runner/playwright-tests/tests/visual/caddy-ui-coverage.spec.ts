import { expect, test } from '@playwright/test';
import { authenticatedSessionState, testForwardAuthService } from '../deep/shared/forward-auth';
import { browserRouteCatalog, isRuntimeExcluded, visualRoutes } from '../../utils/route-catalog';
import { rootUrl } from '../../utils/stack-urls';

const explicitVisualCoverageHosts = [
  'apex',
] as const;

const excludedVisualCoverageHosts = new Set([
  'www',
  'homepage',
]);
const genericVisualHosts = new Set(visualRoutes.map((route) => route.host));
const allCoveredVisualHosts = new Set<string>([
  ...genericVisualHosts,
  ...explicitVisualCoverageHosts,
]);
const routeHostFilterEnabled = (process.env.PLAYWRIGHT_ROUTE_HOSTS || '').trim().length > 0;

const browserUiHosts = browserRouteCatalog
  .filter((route) => route.ownership.route && route.ownership.visual && route.kind !== 'non_ui' && route.kind !== 'orphaned' && !isRuntimeExcluded(route))
  .map((route) => route.host)
  .filter((host) => !excludedVisualCoverageHosts.has(host));

test.describe('Caddy UI Visual Coverage', () => {
  test('every browser UI route exposed by Caddy has screenshot coverage', () => {
    const uncoveredHosts = browserUiHosts.filter((host) => !allCoveredVisualHosts.has(host));
    const explicitlyCoveredButMissingHosts = explicitVisualCoverageHosts.filter(
      (host) => !browserUiHosts.includes(host)
    );

    expect(
      uncoveredHosts,
      `Browser UI hosts missing screenshot coverage: ${uncoveredHosts.join(', ')}`
    ).toEqual([]);
    if (!routeHostFilterEnabled) {
      expect(
        explicitlyCoveredButMissingHosts,
        `Explicit visual coverage hosts missing from the browser route catalog: ${explicitlyCoveredButMissingHosts.join(', ')}`
      ).toEqual([]);
    }
  });

  test.describe('Explicit Visual Snapshots', () => {
    test.use({ storageState: authenticatedSessionState });

    test('Apex portal snapshot', async ({ page }) => {
      await testForwardAuthService(
        page,
        'Apex Portal',
        rootUrl('/'),
        /(Datamancy|Keycloak|Grafana|BookStack)/i,
        {
          screenshotSuffix: 'authenticated',
          screenshotFullPage: true,
        }
      );
    });
  });
});
