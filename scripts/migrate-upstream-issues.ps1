param(
    [string]$SourceRepo = 'technomancer702/nodecast-tv',
    [string]$TargetRepo = 'MikaelKW/nodecast-tv-plus'
)

$ErrorActionPreference = 'Stop'

function Invoke-GhJson {
    param([string[]]$Arguments)

    $output = & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gh failed: gh $($Arguments -join ' ')"
    }
    if (-not $output) { return $null }
    return ($output | Out-String | ConvertFrom-Json)
}

function Send-GhJson {
    param(
        [string]$Endpoint,
        [hashtable]$Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 20 -Compress
    $output = $json | gh api --method POST $Endpoint --input -
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub write failed for $Endpoint"
    }
    return ($output | ConvertFrom-Json)
}

$sourcePages = Invoke-GhJson @('api', '--paginate', '--slurp', "repos/$SourceRepo/issues?state=open&per_page=100")
$sourceIssues = @($sourcePages | ForEach-Object { $_ } | ForEach-Object { $_ }) |
    Where-Object { -not $_.pull_request } |
    Sort-Object number

$targetPages = Invoke-GhJson @('api', '--paginate', '--slurp', "repos/$TargetRepo/issues?state=all&per_page=100")
$targetItems = @($targetPages | ForEach-Object { $_ } | ForEach-Object { $_ })
$existingMarkers = [System.Collections.Generic.HashSet[string]]::new()
foreach ($item in $targetItems) {
    if ($item.body -match '<!-- upstream-issue: ([^ ]+) -->') {
        [void]$existingMarkers.Add($Matches[1])
    }
}

foreach ($issue in $sourceIssues) {
    $marker = "$SourceRepo#$($issue.number)"
    if ($existingMarkers.Contains($marker)) {
        Write-Host "Skipping already migrated issue $marker"
        continue
    }

    $originalBody = if ($issue.body) { $issue.body } else { '_No description was provided._' }
    $body = @"
<!-- upstream-issue: $marker -->
> [!NOTE]
> Migrated from [$marker]($($issue.html_url)). Originally opened by [@$($issue.user.login)]($($issue.user.html_url)) on $($issue.created_at).

---

$originalBody
"@

    $labels = @($issue.labels | ForEach-Object { $_.name })
    $created = Send-GhJson "repos/$TargetRepo/issues" @{
        title = $issue.title
        body = $body
        labels = $labels
    }

    Write-Host "Created target issue #$($created.number) from $marker"

    $comments = Invoke-GhJson @('api', '--paginate', '--slurp', "repos/$SourceRepo/issues/$($issue.number)/comments?per_page=100")
    $comments = @($comments | ForEach-Object { $_ } | ForEach-Object { $_ })
    foreach ($comment in $comments) {
        $commentBody = @"
> [!NOTE]
> Historical comment by [@$($comment.user.login)]($($comment.user.html_url)) on $($comment.created_at), copied from [the upstream discussion]($($comment.html_url)).

$($comment.body)
"@
        [void](Send-GhJson "repos/$TargetRepo/issues/$($created.number)/comments" @{ body = $commentBody })
    }

    [void]$existingMarkers.Add($marker)
}

Write-Host "Issue migration complete. Processed $($sourceIssues.Count) open upstream issues."
