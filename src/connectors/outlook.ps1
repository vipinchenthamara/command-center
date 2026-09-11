# Read-only Outlook collection via COM. Verified: reading .Body does NOT alter UnRead state.
# Emits UTF-8 JSON to -OutFile. Never sends, never modifies, never marks read.
param(
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$SinceUtc = "",
  [int]$MaxItems = 400,
  [int]$BodyChars = 2500,
  [string]$Folders = "inbox,sent"
)

$ErrorActionPreference = "Stop"
$result = [ordered]@{
  ok = $false; account = ""; items = @(); folders = (New-Object System.Collections.ArrayList);
  coverageComplete = $true; error = ""; truncated = $false
}

# Bulk markers live in the footer, which truncation removes. Test the FULL body here
# and hand the verdict downstream, so a newsletter is never mistaken for a real request.
function Get-BulkHint([object]$item) {
  try {
    $b = $item.Body
    if (-not $b) { return $false }
    if ($b -match "(?i)(unsubscribe|manage your preferences|update your preferences|opt.?out|view (this|it) in (your )?browser|privacy policy|you (are )?receiv(ed|ing) this (email|message)|email preferences|no longer wish to receive)") { return $true }
    # Microsoft's first-contact safety tip: a strong signal this is not a colleague.
    if ($b -match "(?i)You don't often get email from") { return $true }
    return $false
  } catch { return $false }
}

function Get-Body([object]$item, [int]$max) {
  try {
    $b = $item.Body
    if (-not $b) { return "" }
    $b = $b -replace "`r`n", "`n"
    # Trim quoted reply chains and signature noise so evidence stays bounded.
    $cut = [regex]::Match($b, "(?m)^\s*(From:|-----Original Message-----|On .{5,80} wrote:)")
    if ($cut.Success -and $cut.Index -gt 120) { $b = $b.Substring(0, $cut.Index) }
    $b = ($b -replace "\n{3,}", "`n`n").Trim()
    if ($b.Length -gt $max) { return $b.Substring(0, $max) }
    return $b
  } catch { return "" }
}

try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $result.account = $ns.CurrentUser.Name
  try { $result.account = $ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress } catch {}

  $since = $null
  if ($SinceUtc -ne "") { try { $since = ([datetime]::Parse($SinceUtc)).ToLocalTime() } catch {} }
  if (-not $since) { $since = (Get-Date).AddDays(-7) }

  $folderMap = @{ "inbox" = 6; "sent" = 5 }
  $collected = New-Object System.Collections.ArrayList

  foreach ($fname in ($Folders -split ",")) {
    $fname = $fname.Trim().ToLower()
    if (-not $folderMap.ContainsKey($fname)) { continue }
    $folder = $ns.GetDefaultFolder($folderMap[$fname])
    $dateField = if ($fname -eq "sent") { "[SentOn]" } else { "[ReceivedTime]" }
    $filter = "$dateField >= '" + $since.ToString("g") + "'"

    $items = $null
    try { $items = $folder.Items.Restrict($filter) } catch { $items = $folder.Items }
    try { $items.Sort($dateField, $true) } catch {}

    $fCount = 0
    foreach ($i in $items) {
      if ($collected.Count -ge $MaxItems) { $result.coverageComplete = $false; $result.truncated = $true; break }
      try {
        if ($i.Class -ne 43) { continue }   # olMail only
        $when = if ($fname -eq "sent") { $i.SentOn } else { $i.ReceivedTime }
        if ($when -lt $since) { continue }
        $entry = [ordered]@{
          sourceId    = $i.EntryID
          folder      = $fname
          direction   = if ($fname -eq "sent") { "outbound" } else { "inbound" }
          subject     = [string]$i.Subject
          senderName  = [string]$i.SenderName
          senderEmail = ""
          to          = [string]$i.To
          cc          = [string]$i.CC
          receivedAt  = $when.ToUniversalTime().ToString("o")
          modifiedAt  = $i.LastModificationTime.ToUniversalTime().ToString("o")
          unread      = [bool]$i.UnRead
          flagged     = ($i.FlagStatus -eq 2)
          importance  = [int]$i.Importance
          categories  = [string]$i.Categories
          conversation= [string]$i.ConversationID
          bulkHint    = (Get-BulkHint $i)
          body        = (Get-Body $i $BodyChars)
        }
        try { $entry.senderEmail = [string]$i.SenderEmailAddress } catch {}
        [void]$collected.Add($entry)
        $fCount++
      } catch { continue }
    }
    [void]$result.folders.Add(@{ name = $fname; items = $fCount })
  }

  $result.items = $collected.ToArray()
  $result.folders = $result.folders.ToArray()
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
  $result.ok = $false
  $result.coverageComplete = $false
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
