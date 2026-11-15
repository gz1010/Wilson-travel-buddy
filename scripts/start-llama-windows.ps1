# Starts Bonsai-2 on Windows (CPU) for development, on 127.0.0.1:8080, the
# address the app and `npm run test:live` use. The judged build runs on the
# Mac through scripts/start.sh; this is only for working on prompts on B's PC.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-llama-windows.ps1          # 4B
#   powershell -ExecutionPolicy Bypass -File scripts\start-llama-windows.ps1 -Size 2B
#
# First run downloads PrismML's Windows CPU llama-server (20 MB) and the
# model (4B: 1.1 GB, 2B: 0.5 GB) into %LOCALAPPDATA%\TravelBuddy and checks
# their SHA-256.
#
# Do not add --reasoning-format none (PrismML's generic Windows launcher
# does): the empty <think> block then comes through as text and every
# JSON-schema request fails with "Unexpected empty grammar stack".
param([ValidateSet('2B', '4B')][string]$Size = '4B', [int]$Port = 8080)
$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:LOCALAPPDATA 'TravelBuddy'
$Bin = Join-Path $Root 'bin'
$Models = Join-Path $Root 'models'
New-Item -ItemType Directory -Force -Path $Bin, $Models | Out-Null

$Release = 'prism-b10828-a153697'
$Zip = "llama-$Release-bin-win-cpu-x64.zip"
$ZipSha = '725f354a0ec041d6ff8851947e6d25b5b459ee5a84074c948cfcad5a7ec9c5cf'
$Gguf = @{
  '2B' = @{ File = 'Ternary-Bonsai-2-2B-PQ2_0.gguf'; Sha = 'd5f01a4ecaf49239653308ee732ad1a0c5f802c0ddb997549fc7b694c8b45928' }
  '4B' = @{ File = 'Ternary-Bonsai-2-4B-PQ2_0.gguf'; Sha = 'd406b1e912c0d2a4c124ad10bf38a76ae662fdc4d24b176451403dc7b7f30409' }
}[$Size]

function Get-Checked($Url, $Out, $Sha) {
  if (-not (Test-Path $Out)) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
  }
  $got = (Get-FileHash -Algorithm SHA256 $Out).Hash.ToLower()
  if ($got -ne $Sha) { Remove-Item $Out; throw "Checksum mismatch for $Out" }
}

$Server = Join-Path $Bin 'llama-server.exe'
if (-not (Test-Path $Server)) {
  $ZipPath = Join-Path $Root $Zip
  Get-Checked "https://github.com/PrismML-Eng/llama.cpp/releases/download/$Release/$Zip" $ZipPath $ZipSha
  Expand-Archive -Path $ZipPath -DestinationPath $Bin -Force
}
$Model = Join-Path $Models $Gguf.File
Get-Checked "https://huggingface.co/prism-ml/Ternary-Bonsai-2-$Size-gguf/resolve/main/$($Gguf.File)" $Model $Gguf.Sha

Write-Host "Starting Bonsai-2 $Size on http://127.0.0.1:$Port (Ctrl-C to stop)"
& $Server -m $Model --host 127.0.0.1 --port $Port -c 8192 --jinja --reasoning-budget 0 `
  --chat-template-kwargs '{\"enable_thinking\":false}'
