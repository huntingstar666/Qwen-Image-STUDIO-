# 从 ComfyUI-Gaoshang-Pose 插件同步「3D 姿态编辑器」资源到 web/vendor/pose3d（约 90MB）。
#
# 编辑器本体（freepose）随仓库走，只有大块二进制被 .gitignore 排除：
#   vnccs/assets/pose_studio_makehuman.v2.bin   82MB 人体数据
#   vnccs/textures/skin.png                    4.5MB 皮肤贴图
#   poses/                                      1.5MB 内置骨架图库（高尚姿势图库）
# 这些文件缺失时编辑器打开会卡在加载人体数据，跑一次本脚本即可。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync_pose3d_assets.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync_pose3d_assets.ps1 -Check

[CmdletBinding()]
param(
    [string]$Source = "<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\custom_nodes\ComfyUI-Gaoshang-Pose",
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Dst = Join-Path $RepoRoot "web\vendor\pose3d"

function Say($msg, $color = "Cyan") { Write-Host "[sync-pose3d] $msg" -ForegroundColor $color }

function DirSize($path) {
    if (-not (Test-Path $path)) { return "缺失" }
    $sum = (Get-ChildItem $path -Recurse -File | Measure-Object -Property Length -Sum).Sum
    return "{0:N1} MB" -f ($sum / 1MB)
}

if ($Check) {
    $missing = 0
    foreach ($rel in @("vnccs\assets\pose_studio_makehuman.v2.bin", "vnccs\textures\skin.png")) {
        if (Test-Path (Join-Path $Dst $rel)) { Say "$rel 就绪" "Green" }
        else { Say "缺少 $rel（跑一次本脚本即可）" "Yellow"; $missing++ }
    }
    $poses = Join-Path $Dst "poses"
    $count = if (Test-Path $poses) { (Get-ChildItem $poses -File).Count } else { 0 }
    if ($count -gt 0) { Say "poses：$count 张骨架图" "Green" }
    else { Say "缺少 poses（内置姿势图库）" "Yellow"; $missing++ }
    if ($missing -gt 0) { exit 1 }
    Say "3D 姿态资源就绪" "Green"
    exit 0
}

if (-not (Test-Path $Source)) {
    Say "源目录不存在：$Source" "Red"
    Say "请用 -Source 指向 ComfyUI-Gaoshang-Pose 插件目录" "Red"
    exit 1
}

# 编辑器只依赖 freepose 这一条链路；studio.* 是插件的另一个页面，不需要复制
$editorFiles = @(
    "freepose.html", "freepose.css", "freepose.mjs",
    "openpose-lift.mjs", "pose-import.mjs", "state.mjs", "style.css"
)
$vnccsFiles = @(
    "vnccs_pose_studio_core.mjs", "vnccs_pose_morph_runtime.mjs", "vnccs_hand_presets.mjs",
    "three.module.mjs", "OrbitControls.mjs", "TransformControls.mjs", "LICENSE", "README.md"
)

New-Item -ItemType Directory -Force -Path (Join-Path $Dst "editor"), (Join-Path $Dst "vnccs") | Out-Null

Say "同步 editor ..."
foreach ($name in $editorFiles) {
    $src = Join-Path $Source "web\editor\$name"
    if (-not (Test-Path $src)) { Say "缺少 $src" "Red"; exit 1 }
    Copy-Item -LiteralPath $src -Destination (Join-Path $Dst "editor\$name") -Force
}

Say "同步 vnccs ..."
foreach ($name in $vnccsFiles) {
    Copy-Item -LiteralPath (Join-Path $Source "web\vnccs\$name") -Destination (Join-Path $Dst "vnccs\$name") -Force
}
foreach ($folder in @("assets", "textures")) {
    $src = Join-Path $Source "web\vnccs\$folder"
    $target = Join-Path $Dst "vnccs\$folder"
    if (-not (Test-Path $src)) { Say "缺少 $src" "Red"; exit 1 }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath (Join-Path $src "*") -Destination $target -Recurse -Force
}

Say "同步内置骨架图库 ..."
$posesSrc = Join-Path $Source "高尚姿势图库"
if (-not (Test-Path $posesSrc)) {
    Say "缺少 $posesSrc（内置姿势图库不可用）" "Yellow"
} else {
    $posesDst = Join-Path $Dst "poses"
    New-Item -ItemType Directory -Force -Path $posesDst | Out-Null
    Copy-Item -LiteralPath (Join-Path $posesSrc "*") -Destination $posesDst -Recurse -Force
}

Say "editor：$(DirSize (Join-Path $Dst 'editor'))" "Green"
Say "vnccs：$(DirSize (Join-Path $Dst 'vnccs'))" "Green"
Say "poses：$(DirSize (Join-Path $Dst 'poses'))" "Green"
Say "完成。重启服务后打开「姿态参考」即可使用 3D 人偶。" "Green"
