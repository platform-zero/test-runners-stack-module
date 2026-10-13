#!/usr/bin/env python3
"""Source security contracts, distinct from live browser/owner evidence."""
from pathlib import Path
import unittest
import subprocess
import re
import tempfile

ROOT = Path(__file__).resolve().parents[1] / 'stack.containers/test-runner'

class PrivateTLSRuntimeTests(unittest.TestCase):
    def test_browser_tls_enabled_by_default(self):
        text = (ROOT / 'run-tests.sh').read_text()
        self.assertIn('PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-false', text)
        self.assertNotIn('PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-true', text)

    def test_private_env_values_not_podman_arguments(self):
        text = (ROOT / 'run-tests.sh').read_text()
        self.assertIn('private_assignments+=("$assignment")', text)
        self.assertIn('"/proc/self/fd/$env_input"', text)
        self.assertIn('rootless_podman "${final_args[@]}"', text)
        self.assertNotIn('export "$assignment"', text)

    def test_native_matrix_auth_discovery_keeps_owned_gateway_and_tls(self):
        text = (ROOT / 'run-tests.sh').read_text()
        self.assertIn('"matrix-auth.$domain"', text)
        self.assertIn('"$host:host-gateway"', text)
        self.assertIn('PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-false', text)

    def test_anonymous_env_pipe_preserves_host_transport(self):
        text = (ROOT / 'run-tests.sh').read_text()
        start = text.index('        # Send container overrides')
        end = text.index('        rootless_podman "${final_args[@]}"', start)
        block = text[start:end] + '        rootless_podman "${final_args[@]}"\n'
        # Only public source-unit fixture strings; no real credentials or containers.
        script = '''set -euo pipefail
export CONTAINER_HOST=host-transport
TEST_RUNNER_IMAGE=fixture-image
rootless_podman() {
 env HOME=/tmp python3 - "$@" <<'CHECK'
import os, sys
args = sys.argv[1:]
assert not any('source-unit-fixture' in arg for arg in args)
assert os.environ['CONTAINER_HOST'] == 'host-transport'
files = [args[i+1] for i, arg in enumerate(args) if arg == '--env-file']
assert len(files) == 1
with open(files[0]) as stream:
 data = stream.read()
assert 'UNIT_TOKEN=source-unit-fixture' in data
assert 'CONTAINER_HOST=container-transport' in data
assert args.index('--env-file') < args.index('fixture-image')
assert args[-3:] == ['node', '-e', 'const x=1']
CHECK
}
probe() {
 local run_args=(run --rm -e UNIT_TOKEN=source-unit-fixture -e CONTAINER_HOST=container-transport fixture-image node -e 'const x=1')
''' + block + '\n}\nprobe\n'
        result = subprocess.run(['bash'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, 'anonymous environment transport must work without argv values or host override')

    def test_all_declared_bundle_certificates_are_split(self):
        text = (ROOT / 'container-entrypoint.sh').read_text()
        script = text.split("<<'PEM'\n", 1)[1].split('\nPEM', 1)[0]
        source = Path('/etc/ssl/certs/ca-certificates.crt')
        expected = len(set(re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', source.read_text(), re.S)))
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['python3', '-', str(source), directory], input=script, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(list(Path(directory).glob('*.crt'))), expected)
        self.assertIn('for certificate in "$parts"/*.crt', text)

    def test_native_trust_bootstrap_is_not_suppressed(self):
        text = (ROOT / 'container-entrypoint.sh').read_text()
        self.assertNotIn('bootstrap_nss_caddy_ca || true', text)
        self.assertNotIn('update-ca-certificates >/dev/null 2>&1 || true', text)
        self.assertIn('$TEST_USER_HOME/.local/share/pki/nssdb', text)
        self.assertIn('refusing incomplete Chromium trust bootstrap', text)

if __name__ == '__main__':
    unittest.main()
