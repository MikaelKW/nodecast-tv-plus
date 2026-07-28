# Security Policy

## Supported versions

Security fixes are provided for the latest stable NodeCast TV Plus release. Earlier releases should be upgraded before a report is evaluated against the current codebase.

| Version | Security support |
| --- | --- |
| Latest stable release | Supported |
| Earlier releases | Upgrade required |
| Unreleased development branches | Not supported for production use |

## Reporting a vulnerability

Do not report suspected vulnerabilities through a public GitHub issue, discussion, or pull request.

Use GitHub's [private vulnerability reporting form](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/new). A GitHub account is required, but the report is visible only to repository security managers and administrators while it is being reviewed.

Include:

- the affected NodeCast TV Plus version and installation method
- a clear description of the impact
- the minimum steps needed to reproduce the behavior
- relevant logs or screenshots with provider URLs, credentials, tokens, cookies, personal information, and other private data removed
- any suggested remediation or supporting references

Reports are normally acknowledged within seven days. Investigation and release timing depend on severity, reproducibility, and the complexity of a safe fix. Status updates will be provided through the private advisory where practical.

Please allow time for a corrected release to become available before publishing technical details. Confirmed reports may receive credit in the advisory unless anonymity is requested.

## Research guidelines

Security testing must be limited to systems and accounts that the researcher owns or is explicitly authorized to test.

Do not:

- access, modify, or delete another person's data
- disrupt a provider, service, or installation
- use social engineering, denial of service, or physical attacks
- expose credentials, provider access details, personal information, or private media

This project does not currently operate a paid bug-bounty program.

## Scope

The policy covers the NodeCast TV Plus application, its official container images, and repository-controlled automation. Vulnerabilities in an IPTV provider, identity provider, browser, operating system, container runtime, or upstream dependency should also be reported to the responsible project or vendor.
