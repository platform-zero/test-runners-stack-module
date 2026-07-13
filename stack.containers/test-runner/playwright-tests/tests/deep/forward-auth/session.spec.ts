import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  authenticatedSessionState,
  domain,
  screenshotRoot,
  seafileOnlyOfficeFixturePath,
  testForwardAuthService,
  waitForGrafanaShell,
  waitForHomeAssistantShell,
} from '../shared/forward-auth';
import { serviceUrl } from '../../../utils/stack-urls';
import { logPageTelemetry, setupNetworkLogging } from '../../../utils/telemetry';

test.use({ storageState: authenticatedSessionState });

  test('Session works across multiple forward-auth services', async ({ page }) => {
    test.setTimeout(120000);
    console.log('\n🧪 Testing session persistence across services');

    // Visit multiple active forward-auth services in sequence - should not require re-auth.
    // JupyterHub is still a compose-only module in the Podman refactor and is
    // intentionally excluded until it has a generated Podman service.
    const services = [
      {
        name: 'Prometheus',
        path: serviceUrl('prometheus'),
        pattern: /Prometheus|Query|Execute|Alerts/i,
        options: { skipScreenshot: true },
      },
      {
        name: 'Homepage Dashboard',
        path: serviceUrl('portal'),
        pattern: /Datamancy|Keycloak|Grafana|BookStack/i,
        options: { skipScreenshot: true },
      },
    ];

    for (const service of services) {
      console.log(`\n   Visiting ${service.name}...`);
      await testForwardAuthService(page, service.name, service.path, service.pattern, service.options);
      console.log(`   ✅ ${service.name} accessed without re-auth`);
    }

    console.log('\n   ✅ Session persisted across all services\n');
  });
