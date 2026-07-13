# Release process

NodeCast TV Plus uses Semantic Versioning and publishes releases only from tested commits on `main`.

## Version policy

- Patch releases (`2.2.x`) contain compatible bug and security fixes.
- Minor releases (`2.x.0`) contain compatible features and meaningful improvement batches.
- Major releases (`x.0.0`) may contain intentional compatibility changes and require explicit migration guidance.
- A GitHub Release and its `vX.Y.Z` tag are treated as immutable after publication.

## Prepare a release

1. Create a release-readiness issue describing the intended scope and acceptance criteria.
2. Create a short-lived branch from `develop`.
3. Update the version in `package.json` and `package-lock.json` without creating a tag.
4. Add the dated changelog entry and curated notes at `docs/releases/vX.Y.Z.md`.
5. Run the complete application, browser, Docker, dependency, and release-metadata checks.
6. Merge through the protected `develop` → `testing` → `main` promotion path.
7. Confirm that all required checks passed on every stage and record the exact `main` commit selected for release.

## Publish

1. Create a draft GitHub Release named `vX.Y.Z`, targeting the exact verified `main` commit and using the curated notes file.
2. Recheck the tag name, target commit, release title, and notes before publishing.
3. Publish the GitHub Release. Publishing creates the release tag and starts the official multi-architecture container build.
4. Verify the release page and the `linux/amd64` and `linux/arm64` images.
5. Confirm the registry provides `X.Y.Z`, `X.Y`, and `latest` tags. The `latest` tag must point to the newest stable release, not an unreleased `main` build.

Do not push a release tag separately and do not publish a tag before the release candidate is approved. This avoids duplicate image builds and prevents an unverified commit from becoming an immutable release.

## Validation commands

```bash
npm ci
npm test
npm run test:e2e
npm audit --audit-level=high --omit=dev
docker build -t nodecast-tv-plus:release-candidate .
```

The CI workflow repeats the application, browser, audit, and Docker checks on a clean runner. The release workflow also verifies that package metadata, the changelog, curated notes, and release tag agree.

## Rollback

- Keep the application data volume and deployment secrets separate from the container image.
- Back up the data volume before upgrading, particularly when a release includes data-model changes.
- Roll back by recreating the container with the previously tested versioned image or pinned image digest while keeping the data volume.
- The first formal Plus release has no earlier stable Plus version tag. Its fallback is a previously tested `sha-*` image or digest recorded by the deployment operator.
- Never move, replace, or delete a published release tag to perform a rollback.
