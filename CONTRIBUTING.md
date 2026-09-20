# Contributing to NodeCast TV Plus

Thanks for helping improve NodeCast TV Plus. This guide explains how to propose a change and where it enters the release process.

## Before you start

- For a larger feature or behavior change, open an issue first so the scope can be discussed. Small, self-contained fixes can be proposed directly.
- Report suspected security vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not disclose them in a public issue or pull request.
- Never include credentials, tokens, `.env` files, private configuration, private provider URLs, personal data, databases, logs containing sensitive data, or private video files in a contribution.

Use the [issue forms](https://github.com/MikaelKW/nodecast-tv-plus/issues/new/choose) for bug reports, feature requests, or help. Required fields provide the minimum context; logs and screenshots are optional and must be checked for sensitive information. Maintainers can refer to the [issue triage and label guide](docs/ISSUE_TRIAGE.md).

## Create a pull request

1. Fork the repository if needed, and create a descriptive branch from the latest `develop` branch. Branch names such as `fix/short-description`, `feat/short-description`, and `docs/short-description` work well.
2. Avoid mixing unrelated fixes or dependency updates into the same pull request.
3. Test the change locally. See the [development setup and available checks](README.md#development-and-contributing). For code changes, run `npm test` and any browser or container checks relevant to the change. For documentation changes, check links and formatting. If a check or hands-on test could not be run, say so in the pull request.
4. Open the pull request against **`MikaelKW/nodecast-tv-plus:develop`**, not `main`. GitHub suggests `main` because it is the repository default, so check the **base** branch before submitting. An existing pull request can be retargeted without opening a new one.
5. Explain what changed and why, link any related issue using `Related to #123`, and list the automated and hands-on checks performed. Include screenshots for visible interface changes when useful, with private information removed.

Pull requests are reviewed and must pass the required checks before merging. Application changes may also need a local container and hands-on validation. Please keep your branch available while feedback is addressed.

## After a pull request merges

Changes enter `develop` first. They are then validated and promoted through `testing` to `main` as part of the release process. Contributors do not need to open separate pull requests for those promotion steps. A merge into `develop` does not mean the change is available in the latest published container image.

Issues are closed after the relevant change has been released and verified; avoid automatic-closing phrases such as `Fixes #123` in contribution pull requests.
