#!/usr/bin/env python3
"""Source security contracts, distinct from live browser/owner evidence."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'stack.containers/test-runner'

class PrivateTLSRuntimeTests(unittest.TestCase):
    def test_browser_tls_enabled_by_default(self):
        text = (ROOT / 'run-tests.sh').read_text()
        self.assertIn('PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-false', text)
        self.assertNotIn('PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-true', text)

    def test_private_env_values_not_podman_arguments(self):
        text = (ROOT / 'run-tests.sh').read_text()
        self.assertIn('export "$assignment"', text)
        self.assertIn('run_args[index+1]="$key"', text)
        self.assertLess(text.index('run_args[index+1]="$key"'), text.index('rootless_podman "${run_args[@]}"', text.index('run_args[index+1]="$key"')))

    def test_native_trust_bootstrap_is_not_suppressed(self):
        text = (ROOT / 'container-entrypoint.sh').read_text()
        self.assertNotIn('bootstrap_nss_caddy_ca || true', text)
        self.assertNotIn('update-ca-certificates >/dev/null 2>&1 || true', text)
        self.assertIn('$TEST_USER_HOME/.local/share/pki/nssdb', text)
        self.assertIn('refusing incomplete Chromium trust bootstrap', text)

if __name__ == '__main__':
    unittest.main()
