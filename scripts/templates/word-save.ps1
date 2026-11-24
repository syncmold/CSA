# Save Word source files (.doc/.docx) as filtered HTML (Format 10), which convert.mjs parses (html.ts), or as
# plain text (Format 7, saved as UTF-8) for the independent spot check (spot-check.mjs), or writes the text of the
# page headers (Format -1, UTF-8, header text boxes included) so spot-check.mjs can check the company name (#83).
# Reading the table cell by cell over COM took about 20 seconds per file; one SaveAs2 takes about 2.
# ListFile: UTF-8, one "<source path>`t<target path>" per line; targets that already exist are skipped.
# Word sometimes drops the COM connection after many files (RPC_E_DISCONNECTED), or hangs; word.mjs kills a Word
# that stops making progress (the "word-pid" line says which one). Either way the call fails here: restart Word
# and retry the file.
# Needs Microsoft Word on this machine; opens the sources read-only. Called by word.mjs.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$ListFile,
  [Parameter(Mandatory = $true)][ValidateSet(-1, 7, 10)][int]$Format
)

$ErrorActionPreference = 'Stop'
$lines = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ })
$word = $null

# Word started over COM runs as "WINWORD.EXE /Automation -Embedding"; a Word the user opens does not. Only report a
# new automation instance, so the watchdog can never kill the user's own Word (and unsaved work with it).
function Get-AutomationWordIds {
  @(Get-CimInstance Win32_Process -Filter "name='WINWORD.EXE'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '/Automation' } | ForEach-Object { $_.ProcessId })
}

function Start-Word {
  $before = Get-AutomationWordIds
  $script:word = New-Object -ComObject Word.Application
  $script:word.Visible = $false
  $script:word.DisplayAlerts = 0
  $mine = @(Get-AutomationWordIds | Where-Object { $before -notcontains $_ })
  if ($mine.Count -eq 1) { Write-Host "word-pid $($mine[0])" }
}

function Stop-Word {
  if ($null -ne $script:word) {
    try { $script:word.Quit() } catch { }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:word) } catch { }
  }
  $script:word = $null
}

try {
  $done = 0
  foreach ($line in $lines) {
    $source, $target = $line -split "`t"
    $done++
    if (Test-Path -LiteralPath $target) { continue }
    for ($attempt = 1; ; $attempt++) {
      try {
        if ($null -eq $word) { Start-Word }
        $doc = $word.Documents.Open($source, $false, $true, $false)  # ConfirmConversions, ReadOnly, AddToRecentFiles
        # Save under a temporary name first, so a crash mid-save never leaves a target that later runs would skip.
        $partial = "$target.partial" + [System.IO.Path]::GetExtension($target)
        if ($Format -eq -1) {
          $parts = New-Object System.Collections.Generic.List[string]
          foreach ($section in $doc.Sections) {
            foreach ($kind in 1, 2, 3) {  # primary, first page, even pages
              $header = $section.Headers.Item($kind)
              if (-not $header.Exists) { continue }
              $parts.Add($header.Range.Text)
              foreach ($shape in $header.Shapes) {
                try { if ($shape.TextFrame.HasText) { $parts.Add($shape.TextFrame.TextRange.Text) } } catch { }
              }
            }
          }
          [System.IO.File]::WriteAllText($partial, ($parts -join "`n"), (New-Object System.Text.UTF8Encoding $false))
        }
        elseif ($Format -eq 7) {
          # Text defaults to the system code page (Big5 here), which turns characters it lacks into "?": ask for UTF-8.
          $doc.SaveAs2($partial, $Format, $false, '', $false, '', $false, $false, $false, $false, $false, 65001)
        }
        else { $doc.SaveAs2($partial, $Format) }
        $doc.Close($false)
        Move-Item -LiteralPath $partial -Destination $target -Force
        # HTML images go to a side folder; the parser only reads text.
        Remove-Item -LiteralPath "$target.partial.files" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "[$done/$($lines.Count)] $source"
        break
      }
      catch {
        Stop-Word
        if ($attempt -ge 3) { throw "Word could not save $source (format $Format): $($_.Exception.Message)" }
        Write-Host "  retrying after: $($_.Exception.Message)"
      }
    }
  }
}
finally {
  Stop-Word
}
