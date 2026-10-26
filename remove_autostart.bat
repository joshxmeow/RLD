@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart_task.ps1" -Remove
if errorlevel 1 (
    echo Could not remove the RLD Autoworx startup task.
    pause
    exit /b 1
)
pause
