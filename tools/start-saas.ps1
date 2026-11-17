#requires -Version 7.0
[CmdletBinding()]
param([switch]$Restart)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $projectRoot 'saas-server.cjs'
$envFile = Join-Path $projectRoot '.env.saas.local'
$privateInitializer = Join-Path $projectRoot 'data\initialize-private.ps1'
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$recordFile = Join-Path $runtimeDir 'saas-current.json'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $envFile) -and (Test-Path -LiteralPath $privateInitializer)) {
    & $privateInitializer
}

# Read the same environment as npm start, without printing credentials.
Push-Location $projectRoot
try {
    $configJson = & $nodePath "--env-file-if-exists=$envFile" -e 'console.log(JSON.stringify({host:process.env.SAAS_HOST||process.env.HOST||"127.0.0.1",port:Number(process.env.SAAS_PORT||process.env.PORT||4180)}))'
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Node startup configuration.' }
    $config = $configJson | ConvertFrom-Json
} finally {
    Pop-Location
}
if ($config.port -lt 1 -or $config.port -gt 65535 -or $config.port -ne [math]::Floor($config.port)) {
    throw 'SAAS_PORT must be an integer from 1 to 65535.'
}
$connectHost = $config.host
if ($connectHost -eq '0.0.0.0') { $connectHost = '127.0.0.1' }
if ($connectHost -eq '::') { $connectHost = '::1' }
$baseUrl = ([UriBuilder]::new('http', $connectHost, [int]$config.port)).Uri.AbsoluteUri.TrimEnd('/')
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $config.port -ErrorAction SilentlyContinue)
$record = $null
if ($listeners.Count -gt 0) {
    if (Test-Path -LiteralPath $recordFile) {
        $previous = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($previous.processId)"
        if ($existing -and $existing.ExecutablePath -eq $nodePath -and
            $existing.CommandLine.Contains('"' + $serverFile + '"') -and
            $previous.url -eq $baseUrl -and $listeners.OwningProcess -contains $existing.ProcessId) {
            $record = $previous
        }
    }
    if (-not $record) {
        throw "Port $($config.port) is occupied by another process; nothing was stopped."
    }
    if ($Restart) {
        $ownedProcess = Get-Process -Id $record.processId -ErrorAction Stop
        Stop-Process -InputObject $ownedProcess -ErrorAction Stop
        if (-not $ownedProcess.WaitForExit(10000)) { throw 'Previous TTJF process did not exit.' }
        $record.status = 'stopped-for-restart'
        $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
        $record = $null
    }
}
if (-not $record) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutLog = Join-Path $runtimeDir "saas-$stamp.stdout.log"
    $stderrLog = Join-Path $runtimeDir "saas-$stamp.stderr.log"
    # Independent hidden process; its output and identity survive this script.
    $serverProcess = Start-Process -FilePath $nodePath -WorkingDirectory $projectRoot -WindowStyle Hidden -ArgumentList @(
        ('--env-file-if-exists="' + $envFile + '"'), ('"' + $serverFile + '"')
    ) -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    $record = [pscustomobject][ordered]@{
        processId = $serverProcess.Id
        startedAt = (Get-Date).ToString('o')
        url = $baseUrl
        workingDirectory = $projectRoot
        stdoutLog = $stdoutLog
        stderrLog = $stderrLog
        status = 'starting'
        verifiedAt = $null
        error = $null
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
}

$deadline = (Get-Date).AddSeconds(20)
$lastError = 'Server did not become ready.'
do {
    if (-not (Get-Process -Id $record.processId -ErrorAction SilentlyContinue)) {
        $lastError = 'Server exited before readiness checks passed.'
        break
    }
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
        $homepage = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing -TimeoutSec 2
        if ($health.ok -eq $true -and $homepage.StatusCode -eq 200) {
            $record.status = 'running'
            $record.verifiedAt = (Get-Date).ToString('o')
            $record.error = $null
            $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
            Write-Output "TTJF is running at $baseUrl/ (PID $($record.processId))."
            Write-Output "Health and homepage checks passed. Process record: $recordFile"
            return
        }
        $lastError = 'Health or homepage response was unexpected.'
    } catch {
        $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 400
} while ((Get-Date) -lt $deadline)

$record.status = 'verification-failed'
$record.error = $lastError
$record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
throw "$lastError See $($record.stderrLog) and $($record.stdoutLog)."
