#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Stages exactly the listed files and creates a commit with a non-empty message.
  Enforces explicit staging (no ".") to prevent accidental full-repo commits.

.DESCRIPTION
  DiceTilt commit helper. Use for agent-safe commits with Conventional Commits.

.PARAMETER Message
  Commit message (required, non-empty). Use Conventional Commits: feat|fix|refactor|build|ci|chore|docs|style|perf|test

.PARAMETER Paths
  One or more file paths to stage. "." is not allowed.

.EXAMPLE
  .\scripts\committer.ps1 "feat: add health endpoint" services/api-gateway/src/health.ts
  .\scripts\committer.ps1 "fix: prevent double-spend" services/api-gateway/src/ws.handler.ts packages/shared-types/src/validation.ts
#>

param(
    [switch]$Force,
    [Parameter(Position = 0, Mandatory = $true)]
    [string]$Message,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Paths
)

$ErrorActionPreference = "Stop"

function Write-Usage {
    Write-Host "Usage: .\scripts\committer.ps1 [-Force] `"commit message`" path1 [path2 ...]" -ForegroundColor Yellow
    Write-Host "  -Force   Remove stale index.lock if commit fails" -ForegroundColor Gray
    exit 2
}

if (-not $Paths -or $Paths.Count -eq 0) {
    Write-Usage
}

# Validate commit message
if ($Message -notmatch '\S') {
    Write-Host "Error: commit message must not be empty" -ForegroundColor Red
    exit 1
}

# Disallow "." (defeats safety guardrails)
foreach ($p in $Paths) {
    if ($p -eq ".") {
        Write-Host "Error: '.' is not allowed; list specific paths instead" -ForegroundColor Red
        exit 1
    }
}

# Validate paths exist (or are tracked for deletions)
foreach ($p in $Paths) {
    if (Test-Path $p -ErrorAction SilentlyContinue) { continue }
    git ls-files --error-unmatch -- $p 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { continue }
    git cat-file -e "HEAD:$p" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: file not found: $p" -ForegroundColor Red
        exit 1
    }
}

# Unstage everything, then stage only listed paths
git restore --staged :/
git add -A -- $Paths

# Check for staged changes
$staged = git diff --staged --quiet 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Warning: no staged changes detected for: $($Paths -join ', ')" -ForegroundColor Yellow
    exit 1
}

# Commit
$commitResult = git commit -m $Message -- $Paths 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Committed `"$Message`" with $($Paths.Count) file(s)" -ForegroundColor Green
    exit 0
}

# Handle -Force for stale lock
$lockPath = Join-Path (git rev-parse --show-toplevel) ".git\index.lock"
if ($Force -and (Test-Path $lockPath)) {
    Remove-Item $lockPath -Force
    Write-Host "Removed stale git lock: $lockPath" -ForegroundColor Yellow
    git commit -m $Message -- $Paths 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Committed `"$Message`" with $($Paths.Count) file(s)" -ForegroundColor Green
        exit 0
    }
}

Write-Host $commitResult -ForegroundColor Red
exit 1
