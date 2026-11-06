# 从 image-style-kit 原项目同步「风格库 / MJ 码图馆」预览图（约 107MB）。
#
# 目录 JSON（web/vendor/image-style-kit/data/*.json）里的 preview / thumbnail
# 是 /creative-presets/xxx.webp 这类绝对路径，本脚本把原项目 public/ 下的图片
# 复制到 web/creative-presets 与 web/mj-styles，由 server/main.py 挂静态路由。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync_style_assets.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync_style_assets.ps1 -Source "E:\path\to\AIFISHER\public"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync_style_assets.ps1 -Check

[CmdletBinding()]
param(
    [string]$Source = "<LOCAL_PROJECTS>\mytools\aifisher\AIFISHER\public",
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WebDir = Join-Path $RepoRoot "web"
$folders = @("creative-presets", "mj-styles")

function Say($msg, $color = "Cyan") { Write-Host "[sync-assets] $msg" -ForegroundColor $color }

if ($Check) {
    $missing = 0
    foreach ($folder in $folders) {
        $dir = Join-Path $WebDir $folder
        if (-not (Test-Path $dir)) {
            Say "缺少 $folder（跑一次本脚本即可）" "Yellow"
            $missing++
            continue
        }
        $n = (Get-ChildItem $dir -Recurse -File | Measure-Object)
        $mb = [math]::Round(($n | ForEach-Object { 1 } | Measure-Object).Count * 0, 1)
        $size = [math]::Round(((Get-ChildItem $dir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
        Say "$folder`: $($n.Count) 个文件, $size MB" "Green"
    }
    if ($missing -gt 0) { exit 1 }
    Say "预览图就绪" "Green"
    exit 0
}

if (-not (Test-Path $Source)) {
    Say "源目录不存在：$Source" "Red"
    Say "请用 -Source 指向 image-style-kit 原项目的 public 目录" "Red"
    exit 1
}

foreach ($folder in $folders) {
    $src = Join-Path $Source $folder
    $dst = Join-Path $WebDir $folder
    if (-not (Test-Path $src)) {
        Say "跳过不存在的目录：$src" "Yellow"
        continue
    }
    Say "同步 $folder ..."
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    $n = (Get-ChildItem $dst -Recurse -File | Measure-Object)
    $size = [math]::Round(((Get-ChildItem $dst -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
    Say "$folder`: $($n.Count) 个文件, $size MB" "Green"
}

Say "完成。重启服务后 /creative-presets/ 与 /mj-styles/ 即可访问。" "Green"
