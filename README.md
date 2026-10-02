# test-runners stack module

- Module id: `test-runners`
- Module repo: `test-runners-stack-module`
- Source repo: `test-runner`
- Lifecycle: `active`

## Owned overlays
- `stack.runtime.yaml`
- `stack.config/test-runner`
- `stack.containers/test-runner`
- `stack.containers/android-test-runner`

## Dependencies
- `stack-foundation`

## Runtime behavior

The bundled `./run-tests.sh` command runs through the managed test-runner
container. Even metadata-oriented commands such as `list` and `plan` may build
the `stack/test-runner:local-build` image and start a short-lived container so
the answer matches the materialized bundle.

Test suites must continue to completion after individual failures and report
all statuses that were reached. A failing suite should not prevent later
independent suites from running unless the target itself is unavailable.

Host artifact collection must preserve:

- aggregate logs for the wrapper
- per-suite Playwright reports
- per-suite JSON/JUnit results
- failure attachments such as `test-failed-*.png`, `video.webm`, traces, and
  `error-context.md`

If the top-level log reports a failure, copied JSON/JUnit artifacts must not
silently show zero failures for the same executed subgroup.

## Android app connectivity

`./run-tests.sh android-apps` starts the API 36 KVM emulator, downloads the
13 APKs pinned in `android-apks.lock.json`, verifies their hashes and signers,
and runs the native Appium connectivity cases. It also opens a Seafile DOCX in
ONLYOFFICE Docs through Android Chrome. Each native case launches the real APK,
connects it to its matching stack service, and checks app UI and service-side
evidence. The suite removes its temporary Keycloak users, Forgejo tokens, mail
messages, and Seafile libraries.

The locked native app and service pairs are:

| Android app | Stack service |
| --- | --- |
| Element X | Matrix |
| Home Assistant | Home Assistant native route |
| Jellyfin | Jellyfin |
| Mastodon | Mastodon |
| ntfy | ntfy native route |
| Seafile | Seafile native route |
| GitNex | Forgejo |
| qBitController | qBittorrent native route |
| DAVx5 | SOGo CalDAV/CardDAV |
| Thunderbird | Mail |
| Donetick | Donetick native route |
| Bitwarden | Vaultwarden |
| ONLYOFFICE Documents | Seafile WebDAV |

`android-apps-matrix` adds an API 34 emulator smoke check. `mobile-full` adds
the Playwright mobile browser suite. These commands run on demand through the
host broker; there is no Android nightly timer.

The test runner uses short-lived managed Keycloak users, a local Caddy CA, and
Appium over the test-runners Podman network. The native app suite requires the
matching Caddy routes and service authentication changes from the Android
connectivity rollout.

## Validation

```sh
./tests/validate.sh
```

## Lifecycle

`active` modules are expected to keep `stack.module.json`, owned overlays, and `tests/validate.sh` in sync.
