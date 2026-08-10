# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Thank you for contributing to Project Lifecycle.

## Branch workflow

- Normal contributions target `develop`.
- Stable release pull requests flow from `release/*` to `main`.
- Urgent fixes use `hotfix/*` and enter protected branches only through pull requests.
- `main`, `develop`, `release/*`, and `hotfix/*` require CI and owner review.
- New commits invalidate prior approvals, and all review conversations must be resolved before merging.

Please open a pull request with a clear description, relevant tests, and documentation updates when behavior changes. Do not commit credentials, private data, generated local state, or machine-specific paths.
