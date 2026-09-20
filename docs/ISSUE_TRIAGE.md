# Issue reporting and triage

The issue chooser offers Bug report, Feature request, and Help / question forms. Required fields collect the minimum context; playback details, logs, and screenshots remain optional. Intermittent reports do not need a reliable reproduction, but should describe the circumstances.

The blank-issue option is hidden. Form validation improves normal web submissions; it does not guarantee useful answers or enforce a repository-wide schema on API/CLI submissions or later edits. The forms become available after reaching the default branch, `main`.

## Label conventions

Keep labels small and descriptive. Milestones and the roadmap already track priority, lifecycle stage, and target release; do not duplicate those with labels.

| Label | Meaning |
| --- | --- |
| `bug` | A reported malfunction; not necessarily confirmed. |
| `enhancement` | A feature or improvement proposal. |
| `question` | Help with setup, configuration, or usage. |
| `documentation` | Documentation changes or problems. |
| `maintenance` | Repository, tooling, and internal cleanup work. |
| `needs-triage` | A new report or request awaiting initial review. |
| `needs-info` | Specific information is needed from the reporter. |
| `confirmed` | A reported bug has been reproduced or otherwise verified. |
| `duplicate` | Covered by another linked issue. |
| `invalid` | Not an actionable issue for this repository; explain why. |
| `wontfix` | Deliberately not planned; explain the decision. |
| `good first issue` | Bounded work with enough guidance for a newcomer. |
| `help wanted` | Contributions or specific expertise are welcome. |
| `dependencies`, `javascript`, `github_actions` | Existing dependency/tooling labels retained for automation and filtering. |
| `security` | Public security-policy or already-disclosed work only; never a substitute for private vulnerability reporting. |

Each form adds its category plus `needs-triage`. Maintainers apply the other labels after review; `confirmed` is for bugs, not feature acceptance. Existing labels and historical issues do not need bulk relabeling.

## Initial review

1. Check for sensitive information or a suspected vulnerability before quoting or forwarding the report. Follow [SECURITY.md](../SECURITY.md) for private reporting. Do not copy technical details into a public issue or apply a label that would disclose a confidential finding. If a secret was posted, avoid repeating it, recommend rotation, and use GitHub's available redaction/removal procedures.
2. Check for an existing issue. Link duplicates with a short explanation instead of silently closing them.
3. Confirm the category and remove `needs-triage` once initial review is complete. If details are missing, ask concise, relevant questions and add `needs-info`; remove it when the information arrives. Do not automatically close an issue just because the first report is incomplete.
4. For bugs, record how the behavior was verified before adding `confirmed`. Request playback settings or codec information only for relevant problems. Do not ask for credentials, full provider URLs, private media, or unredacted configuration/log dumps.
5. Ensure the issue is represented in the [roadmap](https://github.com/users/MikaelKW/projects/1). New proposals normally start at Todo / Proposed / Unscheduled. Set a target release only after selecting its scope.
6. Link implementation and promotion PRs without automatic-closing language. Close application issues after the change is released and verified. Repository-only maintenance can close after the change reaches `main` and its live repository behavior is verified, without a numbered application release.

Issue forms and documentation follow the normal `develop` → `testing` → `main` flow. Repository label definitions are maintained separately through GitHub; adding a label does not change application behavior.
