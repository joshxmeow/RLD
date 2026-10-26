@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update_server.ps1"
if errorlevel 1 (
    echo The RLD update did not complete.
    pause
    exit /b 1
)
pause
