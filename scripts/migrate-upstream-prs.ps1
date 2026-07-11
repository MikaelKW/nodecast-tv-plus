param(
    [string]$SourceRepo = 'technomancer702/nodecast-tv',
    [string]$TargetRepo = 'MikaelKW/nodecast-tv-plus',
    [string]$BaseBranch = 'main'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Run this script from the target Git repository.' }

$status = git status --porcelain
if ($status) { throw 'The working tree must be clean before migrating pull requests.' }

$pulls = gh api --paginate --slurp "repos/$SourceRepo/pulls?state=open&per_page=100" |
    ConvertFrom-Json |
    ForEach-Object { $_ } |
    ForEach-Object { $_ } |
    Sort-Object number

foreach ($pull in $pulls) {
    $branch = "migration/upstream-pr-$($pull.number)"
    $existing = gh pr list --repo $TargetRepo --state all --search "Upstream #$($pull.number) in:title" --json number --jq 'length'
    if ([int]$existing -gt 0) {
        Write-Host "Skipping already migrated PR #$($pull.number)"
        continue
    }

    $worktree = Join-Path ([System.IO.Path]::GetTempPath()) "nodecast-tv-plus-pr-$($pull.number)"
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedWorktree = [System.IO.Path]::GetFullPath($worktree)
    if (-not $resolvedWorktree.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe worktree path: $resolvedWorktree"
    }

    if (Test-Path -LiteralPath $resolvedWorktree) {
        git worktree remove --force $resolvedWorktree 2>$null
        if (Test-Path -LiteralPath $resolvedWorktree) {
            throw "Could not safely clear existing worktree $resolvedWorktree"
        }
    }

    git fetch https://github.com/$SourceRepo.git "refs/pull/$($pull.number)/head:refs/remotes/upstream-pr/$($pull.number)"
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch upstream PR #$($pull.number)" }

    git worktree add -b $branch $resolvedWorktree $BaseBranch
    if ($LASTEXITCODE -ne 0) { throw "Could not create worktree for PR #$($pull.number)" }

    try {
        Push-Location $resolvedWorktree
        $commits = gh api --paginate "repos/$SourceRepo/pulls/$($pull.number)/commits?per_page=100" --jq '.[].sha'
        $applied = $true
        foreach ($commit in $commits) {
            git cherry-pick $commit
            if ($LASTEXITCODE -ne 0) {
                git cherry-pick --abort
                $applied = $false
                break
            }
        }

        if (-not $applied) {
            Write-Warning "PR #$($pull.number) conflicts with NodeCast TV Plus and was not recreated."
            continue
        }

        git push --set-upstream origin $branch
        if ($LASTEXITCODE -ne 0) { throw "Could not push $branch" }

        $originalBody = if ($pull.body) { $pull.body } else { '_No description was provided._' }
        $bodyFile = Join-Path $resolvedWorktree 'migration-pr-body.md'
        @"
> [!NOTE]
> Draft migration of [$SourceRepo#$($pull.number)]($($pull.html_url)), originally opened by [@$($pull.user.login)]($($pull.user.html_url)) on $($pull.created_at).
>
> Commits retain their original Git authorship. Review and testing are required before merging into NodeCast TV Plus.

---

$originalBody
"@ | Set-Content -LiteralPath $bodyFile -Encoding utf8

        gh pr create --repo $TargetRepo --draft --base $BaseBranch --head $branch --title "[Upstream #$($pull.number)] $($pull.title)" --body-file $bodyFile
        if ($LASTEXITCODE -ne 0) { throw "Could not create migrated PR #$($pull.number)" }
        Remove-Item -LiteralPath $bodyFile
    }
    finally {
        Pop-Location
        git worktree remove --force $resolvedWorktree
    }
}

Write-Host "Pull request migration pass complete."
