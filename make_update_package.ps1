$ErrorActionPreference = "Stop"
$source = $PSScriptRoot
$packagePath = Join-Path $source "RLD-Update-Package.zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("rld-package-" + [guid]::NewGuid().ToString("N"))
$payloadStage = Join-Path $stage "payload"
$wrapperStage = Join-Path $stage "wrapper"
$payloadPath = Join-Path $wrapperStage "RLD-update-files.zip"

$files = @(
    "README.md", "app.py", "cert_setup.py", "configure_storage.bat", "configure_storage.py",
    "header.png", "icon.svg", "index.html", "manifest.webmanifest", "requirements.txt",
    "logout.png", "clear.png", "print.png", "save.png",
    "rld_logo.png",
    "units_price_list.json",
    "script.js", "service-worker.js", "signature1.png", "signature2.png", "start_server.bat",
    "style.css", "autostart_task.ps1", "install_autostart.bat", "remove_autostart.bat",
    "start_server_hidden.vbs", "update_server.bat", "update_server.ps1",
    "make_update_package.bat", "make_update_package.ps1"
)

try {
    New-Item -ItemType Directory -Path $payloadStage, $wrapperStage -Force | Out-Null
    foreach ($name in $files) {
        $sourceFile = Join-Path $source $name
        if (-not (Test-Path $sourceFile -PathType Leaf)) {
            throw "Cannot create update package; required file is missing: $name"
        }
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $payloadStage $name)
    }
    Compress-Archive -Path (Join-Path $payloadStage "*") -DestinationPath $payloadPath -CompressionLevel Optimal
    Copy-Item -LiteralPath (Join-Path $source "update_server.bat") -Destination (Join-Path $wrapperStage "update_server.bat")
    Copy-Item -LiteralPath (Join-Path $source "update_server.ps1") -Destination (Join-Path $wrapperStage "update_server.ps1")
    Compress-Archive -Path (Join-Path $wrapperStage "*") -DestinationPath $packagePath -CompressionLevel Optimal -Force
    Write-Host "Created $packagePath"
}
finally {
    if (Test-Path $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
