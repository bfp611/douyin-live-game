param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$Rate = 0,
  [string]$Voice = ""
)

Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { exit 2 }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Voice -ne "") {
    try { $synth.SelectVoice($Voice) } catch { }
  }
  $synth.Rate = $Rate
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
