# 把 ComfyUI 的「模型库代码」移植（vendor）进本项目；权重文件仍复用原目录。
#
# 产出：
#   engine/comfy/          完整 comfy 包（纯 Python：DiT / VAE / 文本编码器 / 采样器 / LoRA）
#   engine/node_helpers.py
#   engine/SOURCE.json     来源、版本、commit、文件数、大小（便于追溯）
#   engine/NOTICE.md       来源与 GPL-3.0 许可证说明
#
# 用法（本机没有 pwsh 7，用 Windows PowerShell 调用）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1 -Source "D:\Other\ComfyUI"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1 -Check
#
# 这是唯一需要原 ComfyUI 源码目录的时刻。跑完后本项目不再依赖该目录的代码，
# 只需要它 models/ 下的权重文件（路径在 config.json 里配置）。

[CmdletBinding()]
param(
    [string]$Source = "",
    [string]$Target,
    [string]$Python,
    [switch]$Check
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Target) { $Target = Join-Path $RepoRoot "engine" }
# 解释器：-Python 参数 > 环境变量 Q2I_PYTHON > PATH 里的 python
if (-not $Python) {
    $Python = @($env:Q2I_PYTHON, "python") | Where-Object { $_ } | Select-Object -First 1
}

function Say($msg, $color = "Cyan") { Write-Host "[port-engine] $msg" -ForegroundColor $color }

$SourceComfy = Join-Path $Source "comfy"
$TargetComfy = Join-Path $Target "comfy"

# ---------------------------------------------------------------- 校验模式
if ($Check) {
    if (-not (Test-Path (Join-Path $TargetComfy "sd.py"))) {
        Say "engine 尚未移植（缺少 $TargetComfy\sd.py）" "Red"
        exit 1
    }
    Say "校验：从项目内副本 import comfy ..."
    & $Python (Join-Path $PSScriptRoot "check_engine_port.py") --engine $Target
    exit $LASTEXITCODE
}

# ---------------------------------------------------------------- 源校验
if (-not $Source) {
    Say "请用 -Source 指定 ComfyUI 根目录（含 comfy/ 的那一层），例如：" "Red"
    Say "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1 -Source `"D:\ComfyUI`"" "Red"
    exit 2
}
if (-not (Test-Path (Join-Path $SourceComfy "sd.py"))) {
    Say "找不到 $SourceComfy\sd.py；-Source 需指向 ComfyUI 根目录（含 comfy/ 的那一层）" "Red"
    exit 1
}

$SourceVersion = "unknown"
$versionFile = Join-Path $Source "comfyui_version.py"
if (Test-Path $versionFile) {
    $m = Select-String -Path $versionFile -Pattern '__version__\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $SourceVersion = $m.Matches[0].Groups[1].Value }
}

$SourceCommit = ""
try { $SourceCommit = (& git -C $Source rev-parse HEAD 2>$null | Select-Object -First 1) } catch { }

Say "源: $Source"
Say "ComfyUI 版本: $SourceVersion"
if ($SourceCommit) { Say "commit: $SourceCommit" }
Say "目标: $Target"

# ---------------------------------------------------------------- 复制
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Say "复制 comfy/ ..."
$rcArgs = @(
    $SourceComfy, $TargetComfy,
    "/MIR", "/XD", "__pycache__", "/XF", "*.pyc", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
)
& robocopy @rcArgs | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { Say "robocopy 失败，退出码 $rc" "Red"; exit $rc }

Say "复制 node_helpers.py ..."
Copy-Item (Join-Path $Source "node_helpers.py") (Join-Path $Target "node_helpers.py") -Force

# ---------------------------------------------------------------- 元数据（交给 Python 写，避免 PowerShell 转义坑）
Say "写入 SOURCE.json / NOTICE.md ..."
& $Python (Join-Path $PSScriptRoot "write_engine_notice.py") `
    --target $Target --source $Source --version $SourceVersion --commit "$SourceCommit"
if ($LASTEXITCODE -ne 0) { Say "写元数据失败" "Red"; exit $LASTEXITCODE }

$files = Get-ChildItem $Target -Recurse -File -Include *.py | Where-Object { $_.FullName -notmatch '__pycache__' }
$totalMb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum) / 1MB, 2)

Say "移植完成：$($files.Count) 个 .py，$totalMb MB" "Green"
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 校验：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1 -Check"
Write-Host "  2. 冒烟：`"$Python`" scripts\verify_engine_port.py"
