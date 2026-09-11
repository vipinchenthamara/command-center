# Keeps the Command Center running independently of any terminal or chat session.
#
# The server previously ran as a child of whatever shell started it, so it died with
# that shell. This registers it as a logon task instead: it starts hidden when you log
# in, survives sign-out of other sessions, and restarts itself if it ever exits.
param(
  [string]$TaskName = "CommandCenter-Server",
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -like "*cc.mjs*serve*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  Write-Host "Removed '$TaskName' and stopped the server."
  return
}

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host ("Task     : " + $(if ($t) { $t.State } else { "not registered" }))
  $l = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue
  Write-Host ("Listening: " + $(if ($l) { "yes (pid $($l.OwningProcess))" } else { "no" }))
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node was not found on PATH." }

$action = New-ScheduledTaskAction -Execute $node `
  -Argument "--no-warnings `"$root\cc.mjs`" serve" -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# No time limit: this is a long-running service, not a job that should be reaped.
# RestartCount brings it back if it ever exits unexpectedly.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Personal Command Center local dashboard (127.0.0.1:7777)" `
  -Force | Out-Null

# Start it now so you do not have to log out and back in.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like "*cc.mjs*serve*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

$l = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "  Registered '$TaskName' to start at logon."
Write-Host ("  Now: " + $(if ($l) { "running on http://127.0.0.1:7777/ (pid $($l.OwningProcess))" } else { "not yet listening - check Task Scheduler" }))
Write-Host ""
Write-Host "  Status : .\setup-autostart.ps1 -Status"
Write-Host "  Remove : .\setup-autostart.ps1 -Remove"
Write-Host ""
