$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Join-Path $env:USERPROFILE ".config\opencode"
$payload = Join-Path $root "payload"

function Write-Step($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  OK: $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  WARN: $text" -ForegroundColor Yellow }

Write-Step "Backup"
if (Test-Path $config) {
  $backup = "$config.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $config $backup -Recurse -Force
  Write-Ok "backup: $backup"
} else {
  Write-Ok "no existing config, nothing to back up"
}

Write-Step "Copy payload"
New-Item -ItemType Directory -Force -Path "$config\agents", "$config\commands", "$config\skills", "$config\plugins" | Out-Null
Copy-Item "$payload\agents\*" "$config\agents" -Force
Copy-Item "$payload\commands\*" "$config\commands" -Force
New-Item -ItemType Directory -Force -Path "$config\skills\grilling" | Out-Null
Copy-Item "$payload\skills\grilling\SKILL.md" "$config\skills\grilling\SKILL.md" -Force
if (Test-Path "$config\plugins\squad") { Remove-Item "$config\plugins\squad" -Recurse -Force }
Copy-Item "$payload\plugins\squad" "$config\plugins\squad" -Recurse -Force
if (Test-Path "$config\plugins\oc-stats-patched") { Remove-Item "$config\plugins\oc-stats-patched" -Recurse -Force }
Copy-Item "$payload\plugins\oc-stats-patched" "$config\plugins\oc-stats-patched" -Recurse -Force
if (-not (Test-Path "$config\SQUAD.md")) {
  Copy-Item "$payload\config\SQUAD.md" "$config\SQUAD.md" -Force
}
Write-Ok "agents, commands, grilling skill, squad, oc-stats-patched, SQUAD.md"

Write-Step "Install visual setup"
New-Item -ItemType Directory -Force -Path "$config\themes" | Out-Null
if (Test-Path "$config\plugins\mitsuha-wallpaper") {
  Remove-Item "$config\plugins\mitsuha-wallpaper" -Recurse -Force
}
Copy-Item "$payload\plugins\mitsuha-wallpaper" "$config\plugins\mitsuha-wallpaper" -Recurse -Force
if (Test-Path "$config\skills\wallpaper-swap") {
  Remove-Item "$config\skills\wallpaper-swap" -Recurse -Force
}
Copy-Item "$payload\skills\wallpaper-swap" "$config\skills\wallpaper-swap" -Recurse -Force
Copy-Item "$payload\config\themes\mitsuha.json" "$config\themes\mitsuha.json" -Force
Write-Ok "mitsuha wallpaper, theme, and wallpaper-swap skill"

$agentsExisted = Test-Path "$config\AGENTS.md"

Write-Step "Install OpenCode plugins"
$opencode = Get-Command opencode -ErrorAction SilentlyContinue
if ($opencode) {
  & opencode plugin add cc-safety-net@2.7.12
  & opencode plugin add "@plannotator/opencode@0.28.62"
  Write-Ok "plugin add completed"
} else {
  Write-Warn "opencode CLI not found; config templates will be copied"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & node "$root\merge-config.mjs" "$config"
  & node "$root\merge-cli.mjs" "$config"
  Write-Ok "config merged"
} else {
  Write-Warn "Node.js not found; copy payload\config\opencode.json manually"
  if (-not (Test-Path "$config\opencode.json")) { Copy-Item "$payload\config\opencode.json" "$config\opencode.json" -Force }
}

Write-Step "Install Plannotator"
try {
  $installer = Join-Path $env:TEMP "plannotator-install.ps1"
  Invoke-WebRequest -Uri "https://plannotator.ai/install.ps1" -OutFile $installer -UseBasicParsing
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -NonInteractive -SkipCodex -SkipGemini -SkipKiro -SkipVibe -SkipQwen -SkipClaudePlugin
  $plannotatorExe = Join-Path $env:LOCALAPPDATA "plannotator\plannotator.exe"
  $pythonBin = Join-Path $env:LOCALAPPDATA "Python\bin"
  if ((Test-Path $plannotatorExe) -and (Test-Path $pythonBin)) {
    $link = Join-Path $pythonBin "plannotator.exe"
    if (-not (Test-Path $link)) { New-Item -ItemType HardLink -Path $link -Target $plannotatorExe | Out-Null }
  }
  Write-Ok "plannotator installed"
} catch {
  Write-Warn "plannotator install failed: $($_.Exception.Message)"
  Write-Host "  Run manually: irm https://plannotator.ai/install.ps1 | iex"
}

Write-Step "Install Context7 (CLI + skill)"
try {
  & npx -y "ctx7@latest" setup --opencode --cli -y
  Write-Ok "context7 setup completed"
} catch {
  Write-Warn "context7 setup failed: $($_.Exception.Message)"
  Write-Host "  Run manually: npx ctx7@latest setup --opencode --cli -y"
}

Write-Step "Install graphify"
try {
  & python -m pip install --user --upgrade "graphifyy==0.9.108"
  & python -m graphify install --platform opencode
  $scripts = & python -c "import sysconfig; print(sysconfig.get_path('scripts', scheme='nt_user'))"
  if ($scripts -and (Test-Path $scripts)) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -split ";" -notcontains $scripts) {
      [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $scripts), "User")
      Write-Ok "added to user PATH: $scripts"
    }
    $pythonBin = Join-Path $env:LOCALAPPDATA "Python\bin"
    $graphifyExe = Join-Path $scripts "graphify.exe"
    if ((Test-Path $graphifyExe) -and (Test-Path $pythonBin)) {
      $link = Join-Path $pythonBin "graphify.exe"
      if (-not (Test-Path $link)) { New-Item -ItemType HardLink -Path $link -Target $graphifyExe | Out-Null }
    }
  }
  Write-Ok "graphify installed"
} catch {
  Write-Warn "graphify install failed: $($_.Exception.Message)"
  Write-Host "  Run manually: python -m pip install --user graphifyy==0.9.108; python -m graphify install --platform opencode"
}

Write-Step "Install Windows Terminal"
try {
  $terminal = Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue
  if ($terminal) {
    Write-Ok "Windows Terminal already installed"
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id Microsoft.WindowsTerminal -e --accept-package-agreements --accept-source-agreements --disable-interactivity
    Write-Ok "Windows Terminal installed"
  } else {
    Write-Warn "winget not found; install Windows Terminal manually"
  }
} catch {
  Write-Warn "Windows Terminal install failed: $($_.Exception.Message)"
}

Write-Step "Restore global AGENTS.md"
if (-not $agentsExisted) {
  Copy-Item "$payload\config\AGENTS.md" "$config\AGENTS.md" -Force
  Write-Ok "AGENTS.md installed"
} else {
  Write-Warn "existing AGENTS.md preserved; merge payload\config\AGENTS.md manually if needed"
}

Write-Step "Verify"
if (Get-Command opencode -ErrorAction SilentlyContinue) { & opencode plugin list }
if (Get-Command graphify -ErrorAction SilentlyContinue) { & graphify --version }
if (Get-Command plannotator -ErrorAction SilentlyContinue) { & plannotator --version }
if (Get-Command opencode -ErrorAction SilentlyContinue) { & opencode debug agents }

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Run OpenCode inside Windows Terminal for smooth cursor/wallpaper rendering."
Write-Host "Restart the OpenCode TUI (close and reopen) to load the visual plugins and the mitsuha theme."
Write-Host "Useful commands: /wallpaper, /wallpaper icons 65, /wallpaper panel 60, /oc_stats."
Write-Host "If Context7 asked for device authorization, finish it in the browser."
