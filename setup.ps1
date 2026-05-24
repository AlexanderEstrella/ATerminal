# ATerminal — Full Setup (ATerminal + Cloudflare Tunnel + Windows Service)
# Run once as Administrator:
#   powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot

function Prompt-YN($question) {
    while ($true) {
        $ans = Read-Host "$question [y/n]"
        if ($ans -match '^[Yy]') { return $true }
        if ($ans -match '^[Nn]') { return $false }
    }
}

Write-Host ""
Write-Host "  ATerminal Setup" -ForegroundColor Cyan
Write-Host "  Remote terminal platform for phones and any device" -ForegroundColor Gray
Write-Host ""

# ── Check: must be admin for service install ─────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "NOTE: Not running as Administrator — Windows service install will be skipped." -ForegroundColor Yellow
    Write-Host "      Re-run as Administrator if you want ATerminal to start on boot." -ForegroundColor Gray
    Write-Host ""
}

# ── 1. Node.js ───────────────────────────────────────────────────────────────
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVer = (node --version 2>&1).ToString().Trim()
    $major = [int]($nodeVer.TrimStart("v").Split(".")[0])
    if ($major -lt 22) {
        Write-Host "      Node.js 22+ required. Found: $nodeVer" -ForegroundColor Red
        Write-Host "      Download: https://nodejs.org/en/download" -ForegroundColor Gray
        exit 1
    }
    Write-Host "      Found $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "      Node.js not found. Download: https://nodejs.org/en/download" -ForegroundColor Red
    exit 1
}

# ── 2. npm install ───────────────────────────────────────────────────────────
Write-Host "[2/5] Installing npm dependencies..." -ForegroundColor Yellow
Set-Location $ProjectDir
npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "      npm install failed. Run 'npm install' manually." -ForegroundColor Red
    exit 1
}
Write-Host "      Done." -ForegroundColor Green

# ── 3. ATerminal server init ─────────────────────────────────────────────────
Write-Host "[3/5] Initializing ATerminal..." -ForegroundColor Yellow
$serverConfig = Join-Path $HOME ".aterminal\server.json"
if (Test-Path $serverConfig) {
    Write-Host "      Existing config found — skipping init." -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "      No config found. Running first-time setup..." -ForegroundColor Gray
    Write-Host "      You will be asked to set an admin password (min 12 characters)." -ForegroundColor Gray
    Write-Host ""
    node --no-warnings=ExperimentalWarning bin/aterminal.js server init --host 0.0.0.0 --port 3000
    if ($LASTEXITCODE -ne 0) { exit 1 }
}
Write-Host "      ATerminal config ready." -ForegroundColor Green

# ── 4. Cloudflare Tunnel ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "[4/5] Cloudflare Tunnel Setup" -ForegroundColor Yellow
Write-Host ""
Write-Host "      A Cloudflare tunnel gives you a secure HTTPS URL (e.g. https://abc123.cfargotunnel.com)" -ForegroundColor Gray
Write-Host "      that works from anywhere — no port forwarding, no static IP needed." -ForegroundColor Gray
Write-Host "      Requires a free Cloudflare account (cloudflare.com)." -ForegroundColor Gray
Write-Host ""

$setupTunnel = Prompt-YN "      Set up Cloudflare tunnel now?"

if ($setupTunnel) {

    # Check / install cloudflared
    $cfPath = (Get-Command cloudflared -ErrorAction SilentlyContinue)?.Source
    if (-not $cfPath) {
        Write-Host ""
        Write-Host "      cloudflared not found. Installing via winget..." -ForegroundColor Yellow
        winget install Cloudflare.cloudflared --silent
        $cfPath = (Get-Command cloudflared -ErrorAction SilentlyContinue)?.Source
        if (-not $cfPath) {
            # Try common install path
            $cfPath = "$env:ProgramFiles\cloudflared\cloudflared.exe"
            if (-not (Test-Path $cfPath)) {
                Write-Host "      Could not install cloudflared automatically." -ForegroundColor Red
                Write-Host "      Download manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" -ForegroundColor Gray
                Write-Host "      Then re-run this script." -ForegroundColor Gray
                $setupTunnel = $false
            }
        }
    }

    if ($setupTunnel) {
        Write-Host "      cloudflared found." -ForegroundColor Green
        Write-Host ""

        # Check if already logged in
        $certPath = Join-Path $HOME ".cloudflared\cert.pem"
        if (-not (Test-Path $certPath)) {
            Write-Host "      Step 1: Login to Cloudflare" -ForegroundColor Cyan
            Write-Host "      A browser window will open. Sign in and click 'Authorize'." -ForegroundColor Gray
            Write-Host "      Press Enter to open the browser..."
            Read-Host
            & $cfPath login
            if ($LASTEXITCODE -ne 0) {
                Write-Host "      Login failed. Re-run the script to try again." -ForegroundColor Red
                $setupTunnel = $false
            }
        } else {
            Write-Host "      Already logged in to Cloudflare." -ForegroundColor Green
        }
    }

    if ($setupTunnel) {
        # Check if tunnel already created
        $cfConfigDir = Join-Path $HOME ".cloudflared"
        $tunnelName = "aterminal"
        $existingConfig = Join-Path $cfConfigDir "config.yml"

        $tunnelId = $null

        if (Test-Path $existingConfig) {
            $configContent = Get-Content $existingConfig -Raw
            if ($configContent -match 'tunnel:\s*(\S+)') {
                $tunnelId = $Matches[1]
                Write-Host "      Existing tunnel found: $tunnelId" -ForegroundColor Green
            }
        }

        if (-not $tunnelId) {
            Write-Host ""
            Write-Host "      Step 2: Creating tunnel '$tunnelName'..." -ForegroundColor Cyan
            $createOutput = & $cfPath tunnel create $tunnelName 2>&1
            Write-Host $createOutput -ForegroundColor Gray

            # Extract tunnel ID from output
            if ($createOutput -match 'Created tunnel .+ with id ([a-f0-9-]{36})') {
                $tunnelId = $Matches[1]
            } elseif ($createOutput -match '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})') {
                $tunnelId = $Matches[1]
            }

            if (-not $tunnelId) {
                # Tunnel may already exist — list and find it
                $listOutput = & $cfPath tunnel list 2>&1 | Out-String
                if ($listOutput -match '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s+' + $tunnelName) {
                    $tunnelId = $Matches[1]
                    Write-Host "      Found existing tunnel: $tunnelId" -ForegroundColor Green
                }
            }

            if (-not $tunnelId) {
                Write-Host "      Could not determine tunnel ID. Run 'cloudflared tunnel list' to check." -ForegroundColor Red
                $setupTunnel = $false
            }
        }

        if ($setupTunnel -and $tunnelId) {
            $publicUrl = "https://$tunnelId.cfargotunnel.com"

            # Write cloudflared config.yml
            $credFile = Join-Path $cfConfigDir "$tunnelId.json"
            $configYml = @"
tunnel: $tunnelId
credentials-file: $credFile

ingress:
  - service: http://localhost:3000
"@
            Set-Content -Path $existingConfig -Value $configYml -Encoding UTF8
            Write-Host "      Tunnel config written." -ForegroundColor Green

            # Save public URL into ATerminal server config
            $atConfig = Get-Content $serverConfig -Raw | ConvertFrom-Json
            $atConfig | Add-Member -NotePropertyName publicUrl -NotePropertyValue $publicUrl -Force
            $atConfig | ConvertTo-Json -Depth 5 | Set-Content $serverConfig -Encoding UTF8
            Write-Host "      Public URL saved to ATerminal config." -ForegroundColor Green

            Write-Host ""
            Write-Host "      Your ATerminal URL (permanent):" -ForegroundColor Cyan
            Write-Host "      $publicUrl" -ForegroundColor White
            Write-Host ""
            Write-Host "      NOTE: Bookmark this URL. It never changes." -ForegroundColor Gray
            Write-Host ""

            # Optional: DNS route if they have a domain
            $customDomain = Prompt-YN "      Do you have a Cloudflare domain and want a custom URL (e.g. terminal.yourdomain.com)?"
            if ($customDomain) {
                $hostname = Read-Host "      Enter the hostname (e.g. terminal.yourdomain.com)"
                if ($hostname) {
                    & $cfPath tunnel route dns $tunnelName $hostname
                    # Update config.yml with hostname ingress
                    $configYml = @"
tunnel: $tunnelId
credentials-file: $credFile

ingress:
  - hostname: $hostname
    service: http://localhost:3000
  - service: http_status:404
"@
                    Set-Content -Path $existingConfig -Value $configYml -Encoding UTF8
                    $publicUrl = "https://$hostname"
                    $atConfig.publicUrl = $publicUrl
                    $atConfig | ConvertTo-Json -Depth 5 | Set-Content $serverConfig -Encoding UTF8
                    Write-Host "      Custom URL configured: $publicUrl" -ForegroundColor Green
                }
            }
        }
    }
} else {
    Write-Host "      Skipping Cloudflare tunnel. ATerminal will only be accessible on your local network." -ForegroundColor Gray
    Write-Host "      You can set it up later by re-running this script." -ForegroundColor Gray
}

# ── 5. Windows Service ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "[5/5] Windows Service (auto-start on boot)" -ForegroundColor Yellow
Write-Host ""

if (-not $isAdmin) {
    Write-Host "      Skipped — re-run as Administrator to install services." -ForegroundColor Yellow
} else {
    $installService = Prompt-YN "      Install ATerminal as a Windows service (starts on boot)?"

    if ($installService) {
        $nodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
        if (-not $nodePath) { $nodePath = "node" }

        # Install NSSM if needed
        $nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
        if (-not $nssmPath) {
            Write-Host "      Installing NSSM via winget..." -ForegroundColor Yellow
            winget install NSSM.NSSM --silent
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            $nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
            if (-not $nssmPath) {
                $nssmPath = "$env:ProgramFiles\nssm\win64\nssm.exe"
            }
        }

        if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

        # ATerminal service
        $svcName = "ATerminal"
        $existing = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($existing) {
            & $nssmPath stop $svcName 2>$null
            & $nssmPath remove $svcName confirm 2>$null
        }
        & $nssmPath install $svcName $nodePath "--no-warnings=ExperimentalWarning $ProjectDir\bin\aterminal.js server start"
        & $nssmPath set $svcName AppDirectory $ProjectDir
        & $nssmPath set $svcName AppEnvironmentExtra "NODE_ENV=production" "ATERMINAL_CONFIG_DIR=$HOME\.aterminal"
        & $nssmPath set $svcName DisplayName "ATerminal"
        & $nssmPath set $svcName Description "Self-hosted remote terminal platform"
        & $nssmPath set $svcName Start SERVICE_AUTO_START
        & $nssmPath set $svcName AppStdout "$ProjectDir\logs\service.log"
        & $nssmPath set $svcName AppStderr "$ProjectDir\logs\service-error.log"
        & $nssmPath set $svcName AppRotateFiles 1
        & $nssmPath set $svcName AppRotateSeconds 86400
        & $nssmPath start $svcName

        Write-Host "      ATerminal service installed and started." -ForegroundColor Green

        # Cloudflare tunnel service
        if ($setupTunnel) {
            $cfPath = (Get-Command cloudflared -ErrorAction SilentlyContinue)?.Source
            if (-not $cfPath) { $cfPath = "$env:ProgramFiles\cloudflared\cloudflared.exe" }

            if (Test-Path $cfPath) {
                $cfSvc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
                if ($cfSvc) {
                    Write-Host "      Cloudflare tunnel service already installed." -ForegroundColor Green
                } else {
                    Write-Host "      Installing Cloudflare tunnel service..." -ForegroundColor Yellow
                    & $cfPath service install
                    Start-Service Cloudflared -ErrorAction SilentlyContinue
                    Write-Host "      Cloudflare tunnel service installed and started." -ForegroundColor Green
                }
            }
        }

        Write-Host ""
        Write-Host "  Service management commands:" -ForegroundColor Cyan
        Write-Host "    Stop:    nssm stop ATerminal" -ForegroundColor Gray
        Write-Host "    Start:   nssm start ATerminal" -ForegroundColor Gray
        Write-Host "    Logs:    Get-Content $ProjectDir\logs\service.log -Tail 50" -ForegroundColor Gray
        Write-Host "    Remove:  nssm remove ATerminal confirm" -ForegroundColor Gray
    }
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host ""

$atConfig = Get-Content (Join-Path $HOME ".aterminal\server.json") -Raw | ConvertFrom-Json
if ($atConfig.publicUrl) {
    Write-Host "  Open ATerminal from anywhere:" -ForegroundColor Cyan
    Write-Host "  $($atConfig.publicUrl)" -ForegroundColor White
} else {
    Write-Host "  Open ATerminal on your local network:" -ForegroundColor Cyan
    Write-Host "  http://$(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { !$_.InterfaceAlias.Contains('Loopback') } | Select-Object -First 1 -ExpandProperty IPAddress):3000" -ForegroundColor White
}
Write-Host ""
