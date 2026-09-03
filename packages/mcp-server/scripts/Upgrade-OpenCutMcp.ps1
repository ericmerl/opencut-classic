[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$Config,
	[string]$BunPath,
	[switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Windows-Instance.ps1")

function Invoke-CheckedCommand {
	param(
		[Parameter(Mandatory = $true)][string]$FilePath,
		[Parameter(Mandatory = $true)][string[]]$Arguments
	)
	& $FilePath @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
	}
}

function Stop-OpenCutListener {
	param(
		[Parameter(Mandatory = $true)][int]$Port,
		[Parameter(Mandatory = $true)][string]$RepositoryRoot
	)
	$listeners = @(
		Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
			Select-Object -ExpandProperty OwningProcess -Unique
	)
	foreach ($processId in $listeners) {
		$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
		$commandLine = [string]$process.CommandLine
		$hasServerEntry =
			$commandLine.IndexOf("packages/mcp-server/src/index.ts", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
			$commandLine.IndexOf("packages\mcp-server\src\index.ts", [StringComparison]::OrdinalIgnoreCase) -ge 0
		if (
			$commandLine.IndexOf($RepositoryRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
			-not $hasServerEntry
		) {
			throw "Port $Port is owned by process $processId, which is not this OpenCut MCP installation"
		}
		Stop-Process -Id $processId -ErrorAction Stop
		Wait-Process -Id $processId -ErrorAction SilentlyContinue
	}
}

$instance = Import-OpenCutInstanceConfiguration -Path $Config
$repositoryRoot = Get-OpenCutRepositoryRoot
$bun = Resolve-OpenCutBun -Path $BunPath
$git = Resolve-OpenCutExecutable -Name "git"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$cargo = Resolve-OpenCutExecutable -Name "cargo" -Fallbacks @((Join-Path $cargoBin "cargo.exe"))
$wasmPack = Resolve-OpenCutExecutable -Name "wasm-pack" -Fallbacks @((Join-Path $cargoBin "wasm-pack.exe"))
$toolDirectories = @(
	[IO.Path]::GetDirectoryName($bun),
	[IO.Path]::GetDirectoryName($cargo),
	[IO.Path]::GetDirectoryName($wasmPack)
) | Select-Object -Unique
$env:Path = ($toolDirectories -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:Path
Initialize-OpenCutWebEnvironment

Set-Location -LiteralPath $repositoryRoot
$expectedCommit = (& $git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $expectedCommit -notmatch "^[0-9a-f]{40}$") {
	throw "Could not resolve the expected Git commit"
}

if (-not $SkipInstall) {
	Invoke-CheckedCommand -FilePath $bun -Arguments @("install", "--frozen-lockfile")
}
Invoke-CheckedCommand -FilePath $bun -Arguments @("run", "build:wasm")
$wasmPackage = Join-Path $repositoryRoot "rust\wasm\pkg"
$installedWasmPackage = Join-Path $repositoryRoot "node_modules\opencut-wasm"
if (-not (Test-Path -LiteralPath $installedWasmPackage -PathType Container)) {
	throw "bun install did not create node_modules\opencut-wasm"
}
Copy-Item -Path (Join-Path $wasmPackage "*") -Destination $installedWasmPackage -Recurse -Force
Invoke-CheckedCommand -FilePath $bun -Arguments @("run", "build:web")
Invoke-CheckedCommand -FilePath $bun -Arguments @("run", "test")

Stop-OpenCutListener -Port $instance.BridgePort -RepositoryRoot $repositoryRoot

$runtimeDirectory = Join-Path $instance.StateDirectory "runtime"
$upgradeDirectory = Join-Path $runtimeDirectory "upgrades"
New-Item -ItemType Directory -Path $upgradeDirectory -Force | Out-Null
$stdoutPath = Join-Path $runtimeDirectory "upgrade-capability.json"
$stderrPath = Join-Path $runtimeDirectory "upgrade-capability.log"
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

$probe = Start-Process `
	-FilePath $bun `
	-ArgumentList @(
		"run",
		"packages/mcp-server/scripts/upgrade-capability-probe.ts",
		"--expected-commit",
		$expectedCommit
	) `
	-WorkingDirectory $repositoryRoot `
	-RedirectStandardOutput $stdoutPath `
	-RedirectStandardError $stderrPath `
	-WindowStyle Hidden `
	-Wait `
	-PassThru

if ($probe.ExitCode -ne 0) {
	$diagnostic = if (Test-Path -LiteralPath $stderrPath) {
		Get-Content -LiteralPath $stderrPath -Raw
	} else {
		"No probe diagnostic was written."
	}
	throw "Hidden MCP restart/capability probe failed with exit code $($probe.ExitCode): $diagnostic"
}

$verification = Get-Content -LiteralPath $stdoutPath -Raw | ConvertFrom-Json
if (-not $verification.verified -or $verification.actualCommit -ne $expectedCommit) {
	throw "The replacement MCP capability response did not verify commit $expectedCommit"
}

$receiptPath = Join-Path $upgradeDirectory "$expectedCommit.json"
[pscustomobject]@{
	schemaVersion = 1
	verifiedAt = [DateTime]::UtcNow.ToString("o")
	configuration = $instance.Path
	expectedCommit = $expectedCommit
	capability = $verification
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8

Write-Output "OpenCut MCP upgrade verified commit $expectedCommit"
Write-Output "Receipt: $receiptPath"
Write-Output "The stdio client can now reconnect; its hidden launcher will use the verified build."
