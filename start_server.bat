@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    python -m venv .venv
    if errorlevel 1 (
        echo Could not create the Python environment. Install Python 3.11 or newer and try again.
        pause
        exit /b 1
    )
)

".venv\Scripts\python.exe" -c "import flask, cryptography, reportlab" >nul 2>nul
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

".venv\Scripts\python.exe" configure_storage.py --if-missing
if errorlevel 1 (
    echo Storage folder setup did not complete.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" app.py
if errorlevel 1 (
    echo The local server stopped with an error.
    pause
)
endlocal
