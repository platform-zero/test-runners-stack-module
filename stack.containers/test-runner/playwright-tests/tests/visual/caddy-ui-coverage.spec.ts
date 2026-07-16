import { expect, test } from '@playwright/test';
import { browserWuiRoutes, visualRoutes } from '../../utils/route-catalog';

const genericVisualHosts = new Set(visualRoutes.map((route) => route.host));

test.describe('Caddy UI Visual Coverage', () => {
  test('every independently classified browser UI has a concrete screenshot contract', () => {
    const missingRouteOwnership = browserWuiRoutes
      .filter((route) => !route.ownership.route)
      .map((route) => route.host);
    const missingVisualOwnership = browserWuiRoutes
      .filter((route) => !route.ownership.visual)
      .map((route) => route.host);
    const missingVisualContracts = browserWuiRoutes
      .filter((route) => !route.visual)
      .map((route) => route.host);
    const uncoveredHosts = browserWuiRoutes
      .filter((route) => !genericVisualHosts.has(route.host))
      .map((route) => route.host);

    expect(missingRouteOwnership, `Browser UI hosts missing route ownership: ${missingRouteOwnership.join(', ')}`).toEqual([]);
    expect(missingVisualOwnership, `Browser UI hosts missing visual ownership: ${missingVisualOwnership.join(', ')}`).toEqual([]);
    expect(missingVisualContracts, `Browser UI hosts missing visual contracts: ${missingVisualContracts.join(', ')}`).toEqual([]);
    expect(
      uncoveredHosts,
      `Browser UI hosts missing screenshot coverage: ${uncoveredHosts.join(', ')}`
    ).toEqual([]);
  });
});
