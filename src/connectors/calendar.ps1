# Read-only calendar collection via Outlook COM.
# Recurring appointments are expanded, so Restrict().Count is meaningless here
# (it returns Int32.MaxValue) - always iterate and stop on the window edge.
param(
  [Parameter(Mandatory=$true)][string]$OutFile,
  [int]$DaysAhead = 2,
  [int]$DaysBack = 1,
  [int]$MaxItems = 120
)

$ErrorActionPreference = "Stop"
$result = [ordered]@{ ok = $false; events = (New-Object System.Collections.ArrayList); error = "" }

try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $cal = $ns.GetDefaultFolder(9)

  $items = $cal.Items
  $items.IncludeRecurrences = $true
  $items.Sort("[Start]")

  $from = (Get-Date).Date.AddDays(-$DaysBack)
  $to   = (Get-Date).Date.AddDays($DaysAhead)
  $filter = "[Start] >= '" + $from.ToString("g") + "' AND [Start] < '" + $to.ToString("g") + "'"
  $r = $items.Restrict($filter)

  $n = 0
  foreach ($a in $r) {
    if ($n -ge $MaxItems) { break }
    try {
      if ($a.Start -ge $to) { break }
      if ($a.Start -lt $from) { continue }

      $body = ""
      try { $body = [string]$a.Body } catch {}
      $isTeams = $body -match "teams\.microsoft\.com"

      $req = @()
      try { if ($a.RequiredAttendees) { $req = ($a.RequiredAttendees -split ";") | ForEach-Object { $_.Trim() } | Where-Object { $_ } } } catch {}
      $opt = @()
      try { if ($a.OptionalAttendees) { $opt = ($a.OptionalAttendees -split ";") | ForEach-Object { $_.Trim() } | Where-Object { $_ } } } catch {}

      # Strip the Teams joining boilerplate so the preview is the human agenda, if any.
      $agenda = ""
      if ($body) {
        $cut = [regex]::Match($body, "(?i)(________|Microsoft Teams|Join the meeting now|Meeting ID:)")
        $agenda = if ($cut.Success -and $cut.Index -gt 0) { $body.Substring(0, $cut.Index) } else { $body }
        $agenda = ($agenda -replace "\s+", " ").Trim()
        if ($agenda.Length -gt 400) { $agenda = $agenda.Substring(0, 400) }
      }

      $entry = [ordered]@{
        sourceId   = [string]$a.GlobalAppointmentID
        subject    = [string]$a.Subject
        start      = $a.Start.ToUniversalTime().ToString("o")
        end        = $a.End.ToUniversalTime().ToString("o")
        durationMin= [int]$a.Duration
        organizer  = [string]$a.Organizer
        location   = [string]$a.Location
        isTeams    = [bool]$isTeams
        isRecurring= [bool]$a.IsRecurring
        allDay     = [bool]$a.AllDayEvent
        required   = $req
        optional   = $opt
        agenda     = $agenda
        responseStatus = [int]$a.ResponseStatus
      }
      [void]$result.events.Add($entry)
      $n++
    } catch { continue }
  }

  $result.events = $result.events.ToArray()
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
  $result.ok = $false
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
