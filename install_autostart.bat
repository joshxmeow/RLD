@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart_task.ps1"
if errorlevel 1 (
    echo Could not install the RLD Autoworx startup task.
    pause
    exit /b 1
)
pause
