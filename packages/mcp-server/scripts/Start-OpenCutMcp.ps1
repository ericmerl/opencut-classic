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

Set-Location -LiteralPath $repositoryRoot
[Console]::Error.WriteLine(
	"OpenCut MCP instance on 127.0.0.1:$($instance.BridgePort) starting with state at $($instance.StateDirectory)"
)
& $bun run "packages/mcp-server/src/index.ts"
exit $LASTEXITCODE
