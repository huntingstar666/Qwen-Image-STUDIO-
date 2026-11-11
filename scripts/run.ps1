# 一键启动 Qwen-Image 2.1 工作台（独立服务，不依赖 ComfyUI 服务进程）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run.ps1 -Port 8700
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run.ps1 -Warmup    # 启动后预加载模型
#
# 环境要求：Python 3.10+，且已装 fastapi / uvicorn / pillow / numpy / torch / requests。
# 解释器优先级：-Python 参数 > 环境变量 Q2I_PYTHON > PATH 里的 python。

[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$Warmup,
    [string]$Python,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

function Say($msg, $color = "Cyan") { Write-Host $msg -ForegroundColor $color }

# ---------------------------------------------------------------- 选解释器
if (-not $Python) {
    $candidates = @(
        $env:Q2I_PYTHON,
        (Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($candidate in $candidates) {
        # 注意：torch 会往 stderr 打 FutureWarning，而脚本开头把 ErrorActionPreference 设成了 Stop，
        # 这会把「stderr 有输出」当成终止错误。探测期间必须临时放宽。
        $probePrev = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        # 必须带 -s（禁用 user site-packages）：AppData 里的 torch 是 cu128，
        # 会盖掉 python 自带的 cu130。cu128 下 comfy_kitchen 会禁用 CUDA 原生 int8
        # 算子，采样会掉到 sm80 wmma 慢路径（实测 3 倍慢）。
        & $candidate -s -c "import fastapi, uvicorn, PIL, numpy, torch" *> $null
        $probeCode = $LASTEXITCODE
        $ErrorActionPreference = $probePrev
        if ($probeCode -eq 0) { $Python = $candidate; break }
    }
}
if (-not $Python -or -not (Test-Path $Python)) {
    Say "找不到可用的 Python（需要 fastapi/uvicorn/Pillow/numpy/torch）。" "Red"
    Say "可以这样指定：scripts\run.ps1 -Python `"C:\path\to\python.exe`"" "Red"
    exit 1
}
Say "Python: $Python"

# ---------------------------------------------------------------- torch / CUDA 版本自检
$torchPrev = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
$torchInfo = (& $Python -s -c "import torch; print(torch.__version__ + '|' + str(torch.version.cuda))" 2>$null)
$ErrorActionPreference = $torchPrev
if ($torchInfo) {
    $parts = "$torchInfo".Trim().Split('|')
    Say "Torch:  $($parts[0])  CUDA $($parts[1])"
    $cudaVer = 0.0
    [void][double]::TryParse($parts[1], [ref]$cudaVer)
    if ($cudaVer -gt 0 -and $cudaVer -lt 13) {
        Say "⚠ CUDA < 13：comfy_kitchen 的 int8 原生算子不可用，采样会慢约 3 倍。" "Yellow"
        Say "  请用 python -s 启动（本项目启动器已自动加），或换 cu130 的 torch。" "Yellow"
    }
}

# ---------------------------------------------------------------- 检查引擎是否已移植
if (-not (Test-Path (Join-Path $RepoRoot "engine\comfy\sd.py"))) {
    Say "引擎代码还没移植到本项目（缺少 engine\comfy\sd.py）。" "Yellow"
    Say "先执行一次：" "Yellow"
    Say "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1" "Yellow"
    $answer = Read-Host "现在就移植吗？[Y/n]"
    if ($answer -eq "" -or $answer -match "^[Yy]") {
        & (Join-Path $PSScriptRoot "port_engine.ps1")
        if (-not (Test-Path (Join-Path $RepoRoot "engine\comfy\sd.py"))) { exit 1 }
    } else {
        exit 1
    }
}

# ---------------------------------------------------------------- 端口
if ($Port -eq 0) {
    $Port = try { (Get-Content (Join-Path $RepoRoot "config.json") -Raw | ConvertFrom-Json).port } catch { 0 }
    if (-not $Port) { $Port = 8700 }
}
$env:Q2I_PORT = "$Port"

# ---------------------------------------------------------------- 冒烟检查（可选）
$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://$($HostAddress):$Port/api/health" -TimeoutSec 2
} catch { }
if ($health -and $health.ok) {
    Say "服务已经在 http://$($HostAddress):$Port 运行（版本 $($health.version)），无需重复启动。" "Yellow"
    Start-Process "http://$($HostAddress):$Port"
    exit 0
}

# ---------------------------------------------------------------- 启动
Say ""
Say "==============================================================="
Say "  Qwen-Image 2.1 工作台"
Say "  地址:  http://$($HostAddress):$Port"
Say "  引擎:  项目内 engine/（进程内推理，不需要 ComfyUI 服务）"
Say "  权重:  见 config.json 的 model_root"
Say "==============================================================="
Say ""

if ($Warmup) {
    Say "预加载模型（幂等，可在另一个窗口做）..."
    try { Invoke-RestMethod -Uri "http://$($HostAddress):$Port/api/engine/warmup" -Method Post -TimeoutSec 600 | Out-Null } catch { }
}

# 首次启动时自动打开浏览器。
# 不能用 Register-ObjectEvent 的 -Action 里引用 $using:xxx —— 那在 Windows PowerShell 5.1
# 里会报 "The variable '$using:HostAddress' cannot be retrieved"，改用后台 job 传参。
$url = "http://$($HostAddress):$Port"
Start-Job -ScriptBlock {
    param($target, $delay)
    Start-Sleep -Seconds $delay
    Start-Process $target
} -ArgumentList $url, 4 | Out-Null

# 前台托管 uvicorn。这里必须让 stderr 直通而不触发 Stop：
# 引擎/torch 会打一堆 warning，被当成终止错误会让服务「启动即退出」。
$ErrorActionPreference = 'Continue'
& $Python -s -m uvicorn server.main:app --host $HostAddress --port $Port
exit $LASTEXITCODE
