# test-runners stack module

- Module id: `test-runners`
- Module repo: `test-runners-stack-module`
- Source repo: `test-runner`
- Lifecycle: `active`

## Owned overlays
- `stack.runtime.yaml`
- `stack.config/test-runner`
- `stack.containers/test-runner`

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

## Validation

```sh
./tests/validate.sh
```

## Lifecycle

`active` modules are expected to keep `stack.module.json`, owned overlays, and `tests/validate.sh` in sync.
