# Read Word source files (.doc) of internal-control documents for convert.mjs: the whole text with list numbering
# turned into plain text, and optionally a PDF of each file. Needs Microsoft Word; opens each file read-only and
# never saves it (the numbering conversion only changes the copy in memory).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
# -Jobs: a UTF-8 JSON file, an array of { "path": "...doc", "text": "...txt", "pdf": "...pdf" or null }.
param(
  [Parameter(Mandatory = $true)][string]$Jobs
)

$ErrorActionPreference = 'Stop'
$list = [System.IO.File]::ReadAllText($Jobs, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  foreach ($job in $list) {
    $doc = $word.Documents.Open($job.path, $false, $true)  # ConfirmConversions=false, ReadOnly=true
    try {
      if ($job.pdf) { $doc.ExportAsFixedFormat($job.pdf, 17) }  # 17 = wdExportFormatPDF, before the numbering changes
      $doc.ConvertNumbersToText()
      [System.IO.File]::WriteAllText($job.text, $doc.Content.Text, (New-Object System.Text.UTF8Encoding($false)))
    }
    finally {
      $doc.Close($false)
    }
  }
}
finally {
  $word.Quit()
}
