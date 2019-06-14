## v4.0.0

- Add support for multi-resource locks (via [#55](https://github.com/mike-marcacci/node-redlock/pull/55)).
- **BREAKING:** Change behavior of `unlock` to return an error if one or more entries cannot be removed.
- **BREAKING:** Upgrade required engine to node 8+ in line w/ node LTS roadmap.