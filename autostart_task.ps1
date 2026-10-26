param(
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "RLD Autoworx Server"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "The RLD Autoworx logon task has been removed."
    exit 0
}

$pythonPath = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$configPath = Join-Path $PSScriptRoot "storage-config.json"
$launcherPath = Join-Path $PSScriptRoot "start_server_hidden.vbs"
if (-not (Test-Path $pythonPath)) {
    throw "Run start_server.bat once first to create the Python environment and configure storage."
}
if (-not (Test-Path $configPath) -and -not $env:RLD_DATA_DIR) {
    throw "Run start_server.bat once first to configure the server data folder."
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ('//B //NoLogo "{0}"' -f $launcherPath)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the RLD Autoworx estimate server hidden when this Windows user signs in." `
    -Force | Out-Null

Write-Host "Installed. The RLD server will start hidden when $user signs in to Windows."
Write-Host "Server output is appended to $(Join-Path $PSScriptRoot 'server.log')."
