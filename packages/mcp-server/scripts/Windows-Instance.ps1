$script:OpenCutInstanceVariables = @(
	"OPENCUT_BRIDGE_PORT",
	"OPENCUT_RECEIPT_DIR",
	"OPENCUT_PREVIEW_EVIDENCE_DIR",
	"OPENCUT_OPERATION_LEDGER_DIR",
	"OPENCUT_HISTORY_CHECKPOINT_DIR",
	"OPENCUT_HEADLESS_PROFILE_DIR",
	"OPENCUT_HEADLESS_EDITOR_URL",
	"OPENCUT_HEADLESS_BROWSER_PATH",
	"OPENCUT_HEADLESS_CONNECTION_TIMEOUT_MS",
	"OPENCUT_FFMPEG_PATH",
	"OPENCUT_FFPROBE_PATH",
	"OPENCUT_RENDERER_CLASS",
	"OPENCUT_WASM_ARTIFACT_PATH",
	"OPENCUT_WASM_PACKAGE_VERSION",
	"OPENCUT_AUDIO_CLEANER_COMMAND",
	"OPENCUT_AUDIO_CLEANER_ARGS",
	"OPENCUT_MATTE_PRODUCER_COMMAND",
	"OPENCUT_MATTE_PRODUCER_ARGS",
	"OPENCUT_SUBJECT_TRACKER_COMMAND",
	"OPENCUT_SUBJECT_TRACKER_ARGS"
)

function Get-OpenCutRepositoryRoot {
	return (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

function Import-OpenCutInstanceConfiguration {
	param([Parameter(Mandatory = $true)][string]$Path)

	$expandedPath = [Environment]::ExpandEnvironmentVariables($Path)
	$resolvedPath = (Resolve-Path -LiteralPath $expandedPath).Path
	$configuration = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
	$known = [System.Collections.Generic.HashSet[string]]::new(
		[System.StringComparer]::Ordinal
	)
	foreach ($name in $script:OpenCutInstanceVariables) {
		[void]$known.Add($name)
	}

	foreach ($property in $configuration.PSObject.Properties) {
		if (-not $known.Contains($property.Name)) {
			throw "Unknown OpenCut instance setting: $($property.Name)"
		}
		if ($null -eq $property.Value -or $property.Value -isnot [string]) {
			throw "OpenCut instance setting $($property.Name) must be a string"
		}
		$value = [Environment]::ExpandEnvironmentVariables($property.Value).Trim()
		if ($value.Length -gt 0) {
			Set-Item -LiteralPath "Env:$($property.Name)" -Value $value
		} else {
			Remove-Item -LiteralPath "Env:$($property.Name)" -ErrorAction SilentlyContinue
		}
	}

	if (-not $env:OPENCUT_BRIDGE_TOKEN -or $env:OPENCUT_BRIDGE_TOKEN.Length -lt 32) {
		throw "OPENCUT_BRIDGE_TOKEN must be inherited from the user environment and contain at least 32 characters"
	}
	if (-not $env:OPENCUT_BRIDGE_PORT) {
		throw "The instance configuration must set OPENCUT_BRIDGE_PORT"
	}
	$port = 0
	if (-not [int]::TryParse($env:OPENCUT_BRIDGE_PORT, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
		throw "OPENCUT_BRIDGE_PORT must be an integer from 1024 through 65535"
	}
	if (-not $env:OPENCUT_RECEIPT_DIR) {
		throw "The instance configuration must set OPENCUT_RECEIPT_DIR"
	}

	return [pscustomobject]@{
		Path = $resolvedPath
		BridgePort = $port
		StateDirectory = [IO.Path]::GetFullPath($env:OPENCUT_RECEIPT_DIR)
	}
}

function Resolve-OpenCutBun {
	param([string]$Path)

	if ($Path) {
		return (Resolve-Path -LiteralPath $Path).Path
	}
	$command = Get-Command bun -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}
	$fallback = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
	if (Test-Path -LiteralPath $fallback -PathType Leaf) {
		return (Resolve-Path -LiteralPath $fallback).Path
	}
	throw "Bun was not found on PATH or in %USERPROFILE%\.bun\bin"
}

function Resolve-OpenCutExecutable {
	param(
		[Parameter(Mandatory = $true)][string]$Name,
		[string[]]$Fallbacks = @()
	)

	$command = Get-Command $Name -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}
	foreach ($fallback in $Fallbacks) {
		if (Test-Path -LiteralPath $fallback -PathType Leaf) {
			return (Resolve-Path -LiteralPath $fallback).Path
		}
	}
	throw "$Name was not found on PATH or in its standard per-user installation directory"
}

function Initialize-OpenCutWebEnvironment {
	$siteUrl = if ($env:OPENCUT_HEADLESS_EDITOR_URL) {
		$env:OPENCUT_HEADLESS_EDITOR_URL
	} else {
		"http://127.0.0.1:3000"
	}
	$defaults = @{
		NEXT_PUBLIC_SITE_URL = $siteUrl
		NEXT_PUBLIC_MARBLE_API_URL = "https://api.marblecms.com"
		DATABASE_URL = "postgresql://opencut:opencut@127.0.0.1:5432/opencut"
		BETTER_AUTH_SECRET = $env:OPENCUT_BRIDGE_TOKEN
		UPSTASH_REDIS_REST_URL = "http://127.0.0.1:8079"
		UPSTASH_REDIS_REST_TOKEN = "local-opencut"
		MARBLE_WORKSPACE_KEY = "local-opencut"
		FREESOUND_CLIENT_ID = "local-opencut"
		FREESOUND_API_KEY = "local-opencut"
	}
	foreach ($entry in $defaults.GetEnumerator()) {
		if (-not (Test-Path -LiteralPath "Env:$($entry.Key)")) {
			Set-Item -LiteralPath "Env:$($entry.Key)" -Value $entry.Value
		}
	}
	$env:NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN = $env:OPENCUT_BRIDGE_TOKEN
	$env:NEXT_PUBLIC_OPENCUT_BRIDGE_PORT = $env:OPENCUT_BRIDGE_PORT
}
