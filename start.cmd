@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -Command "$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source; if (-not $node) { $app = Get-AppxPackage -Name OpenAI.CodexPrimaryRuntime -ErrorAction SilentlyContinue | Select-Object -First 1; if ($app) { $path = Join-Path $app.InstallLocation 'dependencies\node\bin\node.exe'; if (Test-Path -LiteralPath $path) { $node = $path } } }; if (-not $node) { Write-Host 'Install Node.js 22 or newer. See README.md.'; exit 1 }; if (-not $env:TELEGRAM_BOT_TOKEN) { $value = Read-Host 'Paste the Telegram bot token from BotFather' -AsSecureString; $env:TELEGRAM_BOT_TOKEN = (New-Object System.Management.Automation.PSCredential('telegram', $value)).GetNetworkCredential().Password }; & $node '.\bot.mjs'; exit $LASTEXITCODE"
if errorlevel 1 pause
