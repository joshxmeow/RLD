@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0make_update_package.ps1"
if errorlevel 1 (
    echo The RLD update package could not be created.
    pause
    exit /b 1
)
echo Copy RLD-Update-Package.zip to the server PC, extract it, and run update_server.bat.
pause
