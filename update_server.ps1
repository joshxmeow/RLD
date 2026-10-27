Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = "Stop"

$packagePath = Join-Path $PSScriptRoot "RLD-update-files.zip"
if (-not (Test-Path $packagePath)) {
    throw "RLD-update-files.zip is missing. Extract the complete update package before running this file."
}

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Choose the existing RLD project folder. Your database and certificates will be preserved."
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "Update cancelled; no files were changed."
    exit 0
}
$target = [System.IO.Path]::GetFullPath($dialog.SelectedPath)
if (-not (Test-Path (Join-Path $target "app.py")) -or
    -not (Test-Path (Join-Path $target "start_server.bat"))) {
    throw "The selected folder is not an existing RLD project folder."
}

$pythonPath = Join-Path $target ".venv\Scripts\python.exe"
if (Test-Path $pythonPath) {
    $runningServer = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
        Where-Object {
            $_.ExecutablePath -and
            $_.ExecutablePath.Equals($pythonPath, [System.StringComparison]::OrdinalIgnoreCase) -and
            $_.CommandLine -and
            $_.CommandLine.Contains((Join-Path $target "app.py"))
        }
    if ($runningServer) {
        foreach ($process in $runningServer) {
            Stop-Process -Id $process.ProcessId -Force
        }
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            Start-Sleep -Milliseconds 500
            $stillRunning = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
                Where-Object {
                    $_.ExecutablePath -and
                    $_.ExecutablePath.Equals($pythonPath, [System.StringComparison]::OrdinalIgnoreCase) -and
                    $_.CommandLine -and
                    $_.CommandLine.Contains((Join-Path $target "app.py"))
                }
            if (-not $stillRunning) {
                break
            }
        }
        if ($stillRunning) {
            throw "Could not stop the existing RLD server process safely."
        }
    }
}

if (Test-NetConnection -ComputerName 127.0.0.1 -Port 8443 -InformationLevel Quiet) {
    throw "Port 8443 is still in use by another process; no update files were changed."
}

$managedFiles = @(
    "README.md", "app.py", "cert_setup.py", "configure_storage.bat", "configure_storage.py",
    "header.png", "icon.svg", "index.html", "manifest.webmanifest", "requirements.txt",
    "rld_logo.png",
    "units_price_list.json",
    "script.js", "service-worker.js", "signature1.png", "signature2.png", "start_server.bat",
    "style.css", "autostart_task.ps1", "install_autostart.bat", "remove_autostart.bat",
    "start_server_hidden.vbs", "update_server.bat", "update_server.ps1",
    "make_update_package.bat", "make_update_package.ps1"
)
$requiredFiles = @(
    "app.py", "cert_setup.py", "configure_storage.py", "header.png", "icon.svg",
    "rld_logo.png",
    "index.html", "manifest.webmanifest", "requirements.txt", "units_price_list.json", "script.js",
    "service-worker.js", "signature1.png", "signature2.png", "start_server.bat", "style.css"
)

$archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
$archiveFiles = @{}
try {
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        if (-not $name -or $name.Contains("/") -or $name.Contains("\") -or
            [System.IO.Path]::IsPathRooted($name) -or $name -eq "." -or $name -eq "..") {
            throw "The update archive contains an unsafe or nested path: $name"
        }
        $archiveFiles[$name] = $true
    }
}
finally {
    $archive.Dispose()
}
foreach ($name in $requiredFiles) {
    if (-not $archiveFiles.ContainsKey($name)) {
        throw "The update package is incomplete; it does not contain $name."
    }
}
foreach ($name in $archiveFiles.Keys) {
    if ($name -notin $managedFiles) {
        throw "The update package contains an unexpected file: $name"
    }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("rld-update-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $stage)
    foreach ($name in $archiveFiles.Keys) {
        Copy-Item -LiteralPath (Join-Path $stage $name) -Destination (Join-Path $target $name) -Force
    }

    $pythonPath = Join-Path $target ".venv\Scripts\python.exe"
    if (-not (Test-Path $pythonPath)) {
        & py.exe -3 -m venv (Join-Path $target ".venv")
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create the project's Python environment."
        }
    }
    & $pythonPath -m pip install -r (Join-Path $target "requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed. Your existing data and configuration were preserved."
    }

    & $pythonPath (Join-Path $target "configure_storage.py") --if-missing
    if ($LASTEXITCODE -ne 0) {
        throw "Storage setup failed. Your existing storage configuration was preserved."
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $target "autostart_task.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "The update was installed, but the Windows logon-startup task could not be registered."
    }

    $wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
    & $wscriptPath //B //NoLogo (Join-Path $target "start_server_hidden.vbs")
    $serverReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-NetConnection -ComputerName 127.0.0.1 -Port 8443 -InformationLevel Quiet) {
            $serverReady = $true
            break
        }
    }
    if (-not $serverReady) {
        throw "The update is installed, but the server did not start. Check $(Join-Path $target 'server.log')."
    }

    Write-Host "RLD has been updated and the server is running in the background."
    Write-Host "The logon-startup task is installed. Existing database, certificates, and storage settings were kept."
}
finally {
    if (Test-Path $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
