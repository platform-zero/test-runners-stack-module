# test-runners stack module

- Module id: `test-runners`
- Module repo: `test-runners-stack-module`
- Source repo: `test-runner`
- Lifecycle: `active`

## Owned overlays
- `stack.compose/test-runners.yml`
- `stack.config/test-runner`
- `stack.containers/test-runner`

## Dependencies
- `stack-foundation`

## Validation

```sh
./tests/validate.sh
```

## Lifecycle

`active` modules are expected to keep `stack.module.json`, owned overlays, and `tests/validate.sh` in sync.
