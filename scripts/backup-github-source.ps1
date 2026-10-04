param(
  [Parameter(Mandatory = $true)]
  [string]$Repository
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$snapshotRoot = Join-Path $env:TEMP ("gia-dinh-tu-hau-github-backup-" + [guid]::NewGuid())

try {
  New-Item -ItemType Directory -Path $snapshotRoot | Out-Null
  Push-Location $projectRoot
  git archive --format=tar HEAD | tar -xf - -C $snapshotRoot
  Pop-Location

  # Deployment bundles and the desktop runtime are retained locally; GitHub is
  # used for the recoverable source snapshot and rejects individual files above 100 MB.
  Get-ChildItem -Path $snapshotRoot -Filter 'site-release-*.tgz' -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Get-ChildItem -Path $snapshotRoot -Filter 'backup-*.zip' -File -ErrorAction SilentlyContinue | Remove-Item -Force
  $desktopRuntime = Join-Path $snapshotRoot 'desktop-dist-1.0.4\win-unpacked.tmp'
  if (Test-Path -LiteralPath $desktopRuntime) { Remove-Item -LiteralPath $desktopRuntime -Recurse -Force }

  git -C $snapshotRoot init -b main
  git -C $snapshotRoot add -A
  git -C $snapshotRoot -c user.name='Gia Dinh Tu Hau Backup' -c user.email='backup@giadinhtuhau.local' commit -m ("Backup source snapshot " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  git -C $snapshotRoot push --force $Repository main
}
finally {
  if (Test-Path -LiteralPath $snapshotRoot) { Remove-Item -LiteralPath $snapshotRoot -Recurse -Force }
}
