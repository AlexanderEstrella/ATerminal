# Install ATerminal server as a Windows service using NSSM.
# Run as Administrator: powershell -ExecutionPolicy Bypass -File install-service.ps1

$ErrorActionPreference = "Stop"
$ServiceName = "ATerminal"
$ProjectDir = $PSScriptRoot

Write-Host "`n=== ATerminal Windows Service Installer ===" -ForegroundColor Cyan

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: Run this script as Administrator." -ForegroundColor Red
    exit 1
}

$serverConfig = Join-Path $HOME ".aterminal\server.json"
if (-not (Test-Path $serverConfig)) {
    Write-Host "ERROR: Server is not initialized for this user." -ForegroundColor Red
    Write-Host "Run first: node bin/aterminal.js server init" -ForegroundColor Yellow
    exit 1
}

$nodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $nodePath) {
    Write-Host "ERROR: node.exe not found in PATH." -ForegroundColor Red
    exit 1
}

$nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
if (-not $nssmPath) {
    Write-Host "NSSM not found. Installing via winget..." -ForegroundColor Yellow
    winget install NSSM.NSSM --silent
    $nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
    if (-not $nssmPath) {
        Write-Host "Could not auto-install NSSM. Install it and add it to PATH, then re-run." -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

Write-Host "Using NSSM: $nssmPath" -ForegroundColor Cyan
Write-Host "Using Node: $nodePath" -ForegroundColor Cyan

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing service..." -ForegroundColor Yellow
    & $nssmPath stop $ServiceName 2>$null
    & $nssmPath remove $ServiceName confirm
}

Write-Host "Installing service '$ServiceName'..." -ForegroundColor Yellow
& $nssmPath install $ServiceName $nodePath "$ProjectDir\bin\aterminal.js" "server" "start"
& $nssmPath set $ServiceName AppDirectory $ProjectDir
& $nssmPath set $ServiceName AppEnvironmentExtra "NODE_ENV=production" "ATERMINAL_CONFIG_DIR=$HOME\.aterminal"
& $nssmPath set $ServiceName DisplayName "ATerminal"
& $nssmPath set $ServiceName Description "Self-hosted ATerminal server"
& $nssmPath set $ServiceName Start SERVICE_AUTO_START
& $nssmPath set $ServiceName AppStdout "$ProjectDir\logs\service.log"
& $nssmPath set $ServiceName AppStderr "$ProjectDir\logs\service-error.log"
& $nssmPath set $ServiceName AppRotateFiles 1
& $nssmPath set $ServiceName AppRotateOnline 1
& $nssmPath set $ServiceName AppRotateSeconds 86400

Write-Host "Starting service..." -ForegroundColor Yellow
& $nssmPath start $ServiceName

Start-Sleep -Seconds 2
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "Service is running." -ForegroundColor Green
} else {
    Write-Host "Service may not have started. Check logs\service-error.log" -ForegroundColor Red
}

Write-Host "`nDone. ATerminal will now auto-start on boot." -ForegroundColor Green
Write-Host "To stop:    nssm stop ATerminal" -ForegroundColor Cyan
Write-Host "To remove:  nssm remove ATerminal confirm" -ForegroundColor Cyan
