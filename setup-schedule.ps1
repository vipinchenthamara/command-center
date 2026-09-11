# Registers the weekday morning collection with Windows Task Scheduler.
#
# Covers PRD A15: the laptop may be asleep at the scheduled time, so the task is
# allowed to wake the machine AND to run late if the window was missed entirely.
# Nothing here claims collection happens while the laptop is off.
param(
  [string]$Time = "07:30",
  [string]$TaskName = "CommandCenter-MorningReview",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node was not found on PATH." }

$action = New-ScheduledTaskAction -Execute $node `
  -Argument "--no-warnings `"$root\cc.mjs`" collect --scheduled" `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $Time

# StartWhenAvailable is the catch-up: one late run after the laptop returns.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Command Center weekday morning collection and briefing" `
  -Force | Out-Null

Write-Host ""
Write-Host "  Scheduled '$TaskName' for $Time on weekdays."
Write-Host "  Working directory: $root"
Write-Host ""
Write-Host "  Behaviour:"
Write-Host "   - Wakes the laptop to run."
Write-Host "   - If the laptop was off or the window was missed, runs once when it next can."
Write-Host "   - A second run will not start while one is active."
Write-Host ""
Write-Host "  Inspect:  Get-ScheduledTask -TaskName $TaskName"
Write-Host "  Run now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Remove :  .\setup-schedule.ps1 -Remove"
Write-Host ""
