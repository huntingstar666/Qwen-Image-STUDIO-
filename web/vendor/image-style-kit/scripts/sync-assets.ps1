# 同步创意库 / MJ 码图馆的预览图。
#
# 模块只内置目录 JSON（data/*.json），不内置约 112MB 的预览图。
# 在源项目里运行本脚本，把 public 下的图片同步到模块 assets/ 目录：
#
#   pwsh -File scripts/sync-assets.ps1
#   pwsh -File scripts/sync-assets.ps1 -SourceRoot ..\public -TargetRoot .\assets -WhatIf
#
param(
  [string]$SourceRoot = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'public'),
  [string]$TargetRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'),
  [switch]$WhatIf
)

$folders = @('creative-presets', 'mj-styles')

if (-not (Test-Path -LiteralPath $SourceRoot)) {
  throw "找不到源目录：$SourceRoot"
}

foreach ($folder in $folders) {
  $source = Join-Path $SourceRoot $folder
  $target = Join-Path $TargetRoot $folder
  if (-not (Test-Path -LiteralPath $source)) {
    Write-Warning "跳过不存在的目录：$source"
    continue
  }
  Write-Host "同步 $folder ..."
  $copy = @{
    LiteralPath = $source
    Destination = $target
    Recurse     = $true
    Force       = $true
  }
  if ($WhatIf) { $copy['WhatIf'] = $true }
  Copy-Item @copy
}

Write-Host "完成。把资源目录挂到宿主静态服务后，可用 createAssetResolver({ creative: '/creative-presets', mj: '/mj-styles' }) 解析预览图地址。" -ForegroundColor Green
