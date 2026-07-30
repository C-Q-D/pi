<#
.SYNOPSIS
从当前 Pi 源码构建、打包并安装本机个人版 Pi。

.DESCRIPTION
脚本使用当前工作树生成版本化隔离安装目录，将所有 Pi 内部包都安装为本地 tarball，
再通过 npm link 把全局 pi 命令切换到该目录。旧发布目录不会被删除，可用于快速回退。

默认执行依赖安装、模型数据准备、npm run check、离线构建、打包、隔离安装和 smoke test。
完整测试不是默认步骤；修改测试或关键行为时，仍应按 AGENTS.md 运行对应测试。

.PARAMETER ReleaseRoot
版本化发布目录的父目录。默认放在全局 npm prefix 的同级 pi-custom-releases 目录。

.PARAMETER ActivateRelease
跳过构建，直接把全局 pi 命令切换到一个既有发布目录，用于版本回退。

.PARAMETER RunTests
构建前额外运行仓库的 test.sh。Windows 下官方测试存在路径、编码和凭据隔离差异，
启用前应确认当前环境适合运行完整非 E2E 测试。
#>
[CmdletBinding()]
param(
	[string]$ReleaseRoot,
	[string]$ActivateRelease,
	[switch]$RunTests
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
	throw "install-local-pi.ps1 需要 PowerShell 7 或更高版本，请使用 pwsh 运行。"
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$npmCommand = (Get-Command "npm.cmd" -ErrorAction Stop).Source
$gitCommand = (Get-Command "git.exe" -ErrorAction Stop).Source

<#
.SYNOPSIS
执行外部命令并在退出码非零时立即终止流程。

.PARAMETER FilePath
外部命令的完整路径或可执行文件名。

.PARAMETER ArgumentList
传给外部命令的参数列表。

.PARAMETER WorkingDirectory
命令工作目录，默认使用仓库根目录。

.PARAMETER CaptureOutput
返回命令输出而不直接写入当前终端。
#>
function Invoke-CheckedCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string]$FilePath,
		[string[]]$ArgumentList = @(),
		[string]$WorkingDirectory = $repoRoot,
		[switch]$CaptureOutput
	)

	Push-Location $WorkingDirectory
	try {
		Write-Host "`n> $FilePath $($ArgumentList -join ' ')" -ForegroundColor DarkCyan
		if ($CaptureOutput) {
			$output = & $FilePath @ArgumentList 2>&1
			$exitCode = $LASTEXITCODE
			if ($exitCode -ne 0) {
				$output | ForEach-Object { Write-Host $_ }
				throw "命令执行失败，退出码 ${exitCode}: $FilePath $($ArgumentList -join ' ')"
			}
			return @($output)
		}

		& $FilePath @ArgumentList
		$exitCode = $LASTEXITCODE
		if ($exitCode -ne 0) {
			throw "命令执行失败，退出码 ${exitCode}: $FilePath $($ArgumentList -join ' ')"
		}
	} finally {
		Pop-Location
	}
}

<#
.SYNOPSIS
验证当前模型数据能否用于离线构建。
#>
function Test-ModelData {
	Push-Location $repoRoot
	try {
		& $npmCommand --prefix packages/ai run check:model-data *> $null
		return $LASTEXITCODE -eq 0
	} finally {
		Pop-Location
	}
}

<#
.SYNOPSIS
从同版本官方 GitHub 发布归档恢复被 Git 忽略的模型数据。

.DESCRIPTION
源码仓库不跟踪 packages/ai/src/providers/data。首次构建或在线模型生成失败后，
优先从带 SHA256SUMS 的官方源码归档恢复同版本数据，避免绕过 npm 发布时间限制。
#>
function Restore-ModelDataFromRelease {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Version
	)

	$ghCommand = (Get-Command "gh.exe" -ErrorAction Stop).Source
	$tarCommand = (Get-Command "tar.exe" -ErrorAction Stop).Source
	$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "pi-model-data-$([guid]::NewGuid().ToString('N'))"
	$archiveName = "pi-$Version-source.tar.gz"
	$tagName = "v$Version"
	$archivePath = Join-Path $tempDirectory $archiveName
	$checksumPath = Join-Path $tempDirectory "SHA256SUMS"
	$extractDirectory = Join-Path $tempDirectory "extracted"

	New-Item -ItemType Directory -Path $tempDirectory | Out-Null
	New-Item -ItemType Directory -Path $extractDirectory | Out-Null

	try {
		Invoke-CheckedCommand -FilePath $ghCommand -ArgumentList @(
			"release",
			"download",
			$tagName,
			"--repo",
			"earendil-works/pi",
			"--pattern",
			$archiveName,
			"--pattern",
			"SHA256SUMS",
			"--dir",
			$tempDirectory
		)

		$checksumLine = Get-Content -LiteralPath $checksumPath |
			Where-Object { $_ -match "$([regex]::Escape($archiveName))$" } |
			Select-Object -First 1
		if (-not $checksumLine) {
			throw "SHA256SUMS 中缺少 $archiveName"
		}

		$expectedHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
		$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
		if ($actualHash -ne $expectedHash) {
			throw "源码归档校验失败，期望 $expectedHash，实际 $actualHash"
		}

		Invoke-CheckedCommand -FilePath $tarCommand -ArgumentList @(
			"-xzf",
			$archivePath,
			"-C",
			$extractDirectory
		)

		$sourceDataDirectory = Get-ChildItem -Directory -Recurse -LiteralPath $extractDirectory |
			Where-Object { $_.FullName -like "*\packages\ai\src\providers\data" } |
			Select-Object -First 1
		if (-not $sourceDataDirectory) {
			throw "官方源码归档中未找到模型数据目录"
		}

		$targetDataDirectory = Join-Path $repoRoot "packages\ai\src\providers\data"
		if (Test-Path -LiteralPath $targetDataDirectory) {
			# 目标是仓库内明确的生成目录，先替换可避免混合不同版本的数据文件。
			Remove-Item -LiteralPath $targetDataDirectory -Recurse -Force
		}
		New-Item -ItemType Directory -Path $targetDataDirectory | Out-Null
		Copy-Item -Path (Join-Path $sourceDataDirectory.FullName "*") -Destination $targetDataDirectory -Recurse -Force
	} finally {
		# 临时目录由本次调用以 GUID 创建，不包含用户文件，可以安全清理。
		if (Test-Path -LiteralPath $tempDirectory) {
			Remove-Item -LiteralPath $tempDirectory -Recurse -Force
		}
	}
}

<#
.SYNOPSIS
确保离线构建所需的模型数据存在且有效。
#>
function Ensure-ModelData {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Version
	)

	if (Test-ModelData) {
		Write-Host "模型数据有效，使用现有本地数据。" -ForegroundColor Green
		return
	}

	Write-Host "模型数据缺失或无效，尝试从官方 v$Version 发布归档恢复。" -ForegroundColor Yellow
	try {
		Restore-ModelDataFromRelease -Version $Version
	} catch {
		Write-Warning "无法从同版本官方发布归档恢复模型数据：$($_.Exception.Message)"
		Write-Host "改为调用在线模型目录生成流程。" -ForegroundColor Yellow
		Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("run", "generate:models")
	}

	if (-not (Test-ModelData)) {
		throw "模型数据准备完成后仍未通过校验"
	}
}

<#
.SYNOPSIS
把全局 pi 命令切换到指定版本化发布目录并执行 smoke test。

.PARAMETER ReleaseDirectory
包含 node/node_modules/@earendil-works/pi-coding-agent 的发布目录。

.PARAMETER ExpectedVersion
smoke test 期望读取到的 Pi 版本号。
#>
function Activate-PiRelease {
	param(
		[Parameter(Mandatory = $true)]
		[string]$ReleaseDirectory,
		[string]$ExpectedVersion
	)

	$resolvedReleaseDirectory = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
	$codingAgentDirectory = Join-Path $resolvedReleaseDirectory "node\node_modules\@earendil-works\pi-coding-agent"
	if (-not (Test-Path -LiteralPath $codingAgentDirectory)) {
		throw "发布目录缺少 coding-agent 安装：$codingAgentDirectory"
	}

	if (-not $ExpectedVersion) {
		$packageManifest = Get-Content -Raw -LiteralPath (Join-Path $codingAgentDirectory "package.json") | ConvertFrom-Json
		$ExpectedVersion = [string]$packageManifest.version
	}

	Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("link", "--ignore-scripts") -WorkingDirectory $codingAgentDirectory

	$globalPrefixOutput = @(Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("prefix", "-g") -CaptureOutput)
	$globalPrefix = ([string]($globalPrefixOutput | Select-Object -Last 1)).Trim()
	$piCommand = Join-Path $globalPrefix "pi.cmd"
	if (-not (Test-Path -LiteralPath $piCommand)) {
		throw "全局 pi 命令不存在：$piCommand"
	}

	$versionOutput = @(Invoke-CheckedCommand -FilePath $piCommand -ArgumentList @("--version") -WorkingDirectory ([System.IO.Path]::GetTempPath()) -CaptureOutput)
	$actualVersion = ([string]($versionOutput | Select-Object -Last 1)).Trim()
	if ($actualVersion -ne $ExpectedVersion) {
		throw "Pi 版本验证失败，期望 $ExpectedVersion，实际 $actualVersion"
	}

	$helpOutput = @(Invoke-CheckedCommand -FilePath $piCommand -ArgumentList @("--help") -WorkingDirectory ([System.IO.Path]::GetTempPath()) -CaptureOutput)
	if (($helpOutput -join "`n") -notmatch "Usage:") {
		throw "pi --help 未返回预期的 Usage 内容"
	}

	$modelOutput = @(Invoke-CheckedCommand -FilePath $piCommand -ArgumentList @("--list-models") -WorkingDirectory ([System.IO.Path]::GetTempPath()) -CaptureOutput)
	if ($modelOutput.Count -lt 2) {
		throw "pi --list-models 未返回有效模型列表"
	}

	Write-Host "`n个人版 Pi 已激活：" -ForegroundColor Green
	Write-Host "  版本：$actualVersion"
	Write-Host "  发布目录：$resolvedReleaseDirectory"
	Write-Host "  全局命令：$piCommand"
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "package.json"))) {
	throw "无法定位 Pi 仓库根目录：$repoRoot"
}

if ($ActivateRelease) {
	Activate-PiRelease -ReleaseDirectory $ActivateRelease
	exit 0
}

$rootManifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json
if ($rootManifest.name -ne "pi-monorepo") {
	throw "当前目录不是 Pi monorepo：$repoRoot"
}

$codingAgentManifestPath = Join-Path $repoRoot "packages\coding-agent\package.json"
$codingAgentManifest = Get-Content -Raw -LiteralPath $codingAgentManifestPath | ConvertFrom-Json
$version = [string]$codingAgentManifest.version
$commitOutput = @(Invoke-CheckedCommand -FilePath $gitCommand -ArgumentList @("rev-parse", "--short=10", "HEAD") -CaptureOutput)
$branchOutput = @(Invoke-CheckedCommand -FilePath $gitCommand -ArgumentList @("branch", "--show-current") -CaptureOutput)
$statusOutput = @(Invoke-CheckedCommand -FilePath $gitCommand -ArgumentList @("status", "--porcelain") -CaptureOutput)
$shortCommit = ([string]($commitOutput | Select-Object -Last 1)).Trim()
$branch = ([string]($branchOutput | Select-Object -Last 1)).Trim()
$isDirty = $statusOutput.Count -gt 0

if (-not $ReleaseRoot) {
	$globalPrefixOutput = @(Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("prefix", "-g") -CaptureOutput)
	$globalPrefix = ([string]($globalPrefixOutput | Select-Object -Last 1)).Trim()
	$ReleaseRoot = Join-Path (Split-Path -Parent $globalPrefix) "pi-custom-releases"
}

$releaseId = "$version-$shortCommit"
if ($isDirty) {
	$releaseId = "$releaseId-dirty-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}
$releaseDirectory = Join-Path $ReleaseRoot $releaseId
if (Test-Path -LiteralPath $releaseDirectory) {
	$releaseDirectory = Join-Path $ReleaseRoot "$releaseId-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}

$tarballDirectory = Join-Path $releaseDirectory "tarballs"
$nodeInstallDirectory = Join-Path $releaseDirectory "node"
New-Item -ItemType Directory -Path $tarballDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $nodeInstallDirectory -Force | Out-Null

Write-Host "准备从当前工作树安装个人版 Pi：" -ForegroundColor Cyan
Write-Host "  分支：$branch"
Write-Host "  提交：$shortCommit"
Write-Host "  工作树修改：$isDirty"
Write-Host "  输出目录：$releaseDirectory"

Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("install", "--ignore-scripts")
Ensure-ModelData -Version $version
Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("run", "check")
Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @("run", "build:offline")

if ($RunTests) {
	$bashCommand = (Get-Command "bash.exe" -ErrorAction Stop).Source
	Invoke-CheckedCommand -FilePath $bashCommand -ArgumentList @("./test.sh")
}

$packages = @(
	@{ Directory = "packages/ai"; Name = "@earendil-works/pi-ai" },
	@{ Directory = "packages/tui"; Name = "@earendil-works/pi-tui" },
	@{ Directory = "packages/agent"; Name = "@earendil-works/pi-agent-core" },
	@{ Directory = "packages/storage/sqlite-node"; Name = "@earendil-works/pi-storage-sqlite-node" },
	@{ Directory = "packages/coding-agent"; Name = "@earendil-works/pi-coding-agent" }
)

$dependencies = [ordered]@{}
foreach ($package in $packages) {
	$packageDirectory = Join-Path $repoRoot $package.Directory
	$packOutput = @(Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @(
		"pack",
		"--silent",
		"--pack-destination",
		$tarballDirectory
	) -WorkingDirectory $packageDirectory -CaptureOutput)
	$tarballName = ([string]($packOutput | Select-Object -Last 1)).Trim()
	if (-not $tarballName.EndsWith(".tgz", [System.StringComparison]::OrdinalIgnoreCase)) {
		throw "npm pack 未返回 tarball 文件名：$($package.Name)"
	}
	$dependencies[$package.Name] = "file:../tarballs/$tarballName"
}

$installManifest = [ordered]@{
	private = $true
	dependencies = $dependencies
	overrides = $dependencies
}
$installManifest |
	ConvertTo-Json -Depth 10 |
	Set-Content -LiteralPath (Join-Path $nodeInstallDirectory "package.json") -Encoding utf8NoBOM

Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @(
	"install",
	"--omit=dev",
	"--ignore-scripts"
) -WorkingDirectory $nodeInstallDirectory

$releaseMetadata = [ordered]@{
	version = $version
	sourceCommit = $shortCommit
	sourceBranch = $branch
	sourceDirty = $isDirty
	sourceRoot = $repoRoot
	builtAt = (Get-Date).ToUniversalTime().ToString("o")
}
$releaseMetadata |
	ConvertTo-Json -Depth 5 |
	Set-Content -LiteralPath (Join-Path $releaseDirectory "发布信息.json") -Encoding utf8NoBOM

Activate-PiRelease -ReleaseDirectory $releaseDirectory -ExpectedVersion $version

Write-Host "`n回退到旧版本时执行：" -ForegroundColor Cyan
Write-Host "  pwsh -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ActivateRelease `"<旧发布目录>`""
