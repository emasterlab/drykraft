# Contributing to DryKraft

Use the setup instructions in [README.md](README.md). Start with a fresh local
workspace and fictional records for reproductions, screenshots, and fixtures.

- Open a GitHub issue for a bug or feature proposal. Include the affected
  module, what you expected, and the smallest set of steps that shows the issue.
- Make focused changes in a fork and open a pull request explaining the
  behavior, the reason for the change, and how you checked it.
- Run `npm run build` before submitting. Run the relevant tests against a
  disposable local database and Redis instance. Put schema changes in an
  ordered migration and describe any data or configuration changes in the PR.
- Keep workspace isolation and permission checks in place. Never add secrets,
  real customer records, or production logs to a public issue or commit.

For a security issue, email support@drykraft.com privately with enough detail
to reproduce it. For contribution licensing, state any third-party material
and its terms in the PR. Submit only code you can provide under the
[project license](LICENSE).
