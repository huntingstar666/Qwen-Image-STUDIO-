@echo off
chcp 65001 >nul
title Qwen-Image 2.1 工作台
cd /d "%~dp0"

echo ===============================================================
echo   Qwen-Image 2.1 工作台
echo   启动后浏览器会自动打开 http://127.0.0.1:8700
echo   关闭本窗口即停止服务
echo ===============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1"
if errorlevel 1 (
  echo.
  echo [错误] 启动失败，请查看上面的提示。
  echo         若是缺少引擎代码，先运行 scripts\port_engine.ps1
  echo.
  pause
)
