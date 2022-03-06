## v4.0.0

- Add support for multi-resource locks (via [#55](https://github.com/mike-marcacci/node-redlock/pull/55)).
- **BREAKING:** Change behavior of `unlock` to return an error if one or more entries cannot be removed.
- **BREAKING:** Upgrade required engine to node 8+ in line w/ node LTS roadmap.

### v4.1.0

- Update scripts for compatibility with LUA 5.2 (via [#63](https://github.com/mike-marcacci/node-redlock/pull/63)).

### v4.2.0

- Update dependencies.
- Stop testing on node version 8. (Due to dev dependency requirements only.)
- Update docs (@ricmatsui via [#80](https://github.com/mike-marcacci/node-redlock/pull/80)).
- Use evalsha for scripts (@yosiat via [#77](https://github.com/mike-marcacci/node-redlock/pull/77)).

## v5.0.0-alpha.1

- Complete rewrite using TypeScript.
- **BREAKING** Significant API changes; see [README.md](./README.md)
- **BREAKING** Remove all production dependencies (replacing Bluebird with native promises).
- **BREAKING** Drop support for Node < 12

## v5.0.0-beta.1

- Compile to both ESM and CJS (@ekosz via [#114](https://github.com/mike-marcacci/node-redlock/pull/114/)).
- Add compatibility with TypeScript 4.4 (@slosd via [#104](https://github.com/mike-marcacci/node-redlock/pull/104)).
- Use docker compose to test against real clusters in CI (via #101)
- Add documentation for contributing.
- Upgrade dependencies.
- **BREAKING** Change types for "using" helper (@ekosz via [#113](https://github.com/mike-marcacci/node-redlock/pull/114/)).

## v5.0.0-beta.2

- Fix regression of retryCount: -1. (fixes #149)
- Export RedlockAbortSignal type. (fixes #138)
- Issue an improved error when passing non-integer durations. (fixes #120)
- Upgrade dependencies.
