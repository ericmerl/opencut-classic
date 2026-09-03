[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$Config,
	[string]$BunPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Windows-Instance.ps1")

$instance = Import-OpenCutInstanceConfiguration -Path $Config
$repositoryRoot = Get-OpenCutRepositoryRoot
$bun = Resolve-OpenCutBun -Path $BunPath
Initialize-OpenCutWebEnvironment

$editorUrl = [Uri]$env:OPENCUT_HEADLESS_EDITOR_URL
if (-not $editorUrl.IsLoopback -or $editorUrl.Scheme -ne "http") {
	throw "OPENCUT_HEADLESS_EDITOR_URL must be an http:// loopback URL"
}
$env:PORT = [string]$editorUrl.Port

Set-Location -LiteralPath $repositoryRoot
Write-Output "OpenCut web editor for MCP instance $($instance.BridgePort) is starting at $editorUrl"
& $bun run "dev:web"
exit $LASTEXITCODE
