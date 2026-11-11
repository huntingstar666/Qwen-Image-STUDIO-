@echo off
setlocal
cd /d "%~dp0"
set PORT=8799

where python >nul 2>nul
if errorlevel 1 (
  echo 未找到 python，请先安装 Python 3 并加入 PATH。
  pause
  exit /b 1
)

rem 不带参数：打开空查看器；带参数：直接以球面模式打开 samples 里的图片
set "VIEWURL=http://127.0.0.1:%PORT%/"
if not "%~1"=="" set "VIEWURL=http://127.0.0.1:%PORT%/?mode=sphere&src=samples/%~1"

start "" "%VIEWURL%"
echo 全景查看器已启动：%VIEWURL%
echo 关闭本窗口即停止服务。
python -m http.server %PORT% --bind 127.0.0.1
