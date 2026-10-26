@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Run start_server.bat once first to install Python dependencies and create the environment.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" configure_storage.py
if errorlevel 1 (
    echo Storage folder was not changed.
    pause
)
endlocal
