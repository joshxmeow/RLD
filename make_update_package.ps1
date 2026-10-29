$ErrorActionPreference = "Stop"
$source = $PSScriptRoot
$packagePath = Join-Path $source "RLD-Update-Package.zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("rld-package-" + [guid]::NewGuid().ToString("N"))
$payloadStage = Join-Path $stage "payload"
$wrapperStage = Join-Path $stage "wrapper"
$payloadPath = Join-Path $wrapperStage "RLD-update-files.zip"

$files = @(
    "README.md", "app.py", "cert_setup.py", "configure_storage.bat", "configure_storage.py",
    "assets/icons/clear.png", "assets/icons/icon.svg", "assets/icons/logout.png",
    "assets/icons/print.png", "assets/icons/rld_logo.png", "assets/icons/save.png",
    "assets/images/header.png", "assets/images/signature1.png", "assets/images/signature2.png",
    "data/Units Price List.xlsx", "data/units_price_list.json",
    "index.html", "manifest.webmanifest", "requirements.txt",
    "script.js", "service-worker.js", "start_server.bat",
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
        $stagedFile = Join-Path $payloadStage $name
        New-Item -ItemType Directory -Path (Split-Path -Parent $stagedFile) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $stagedFile
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
