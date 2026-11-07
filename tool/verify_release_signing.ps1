[CmdletBinding()]
param(
  [string]$ApkPath = (Join-Path $PSScriptRoot '..\build\app\outputs\flutter-apk\app-release.apk'),
  [string]$ExpectedPackage = 'com.albab.paymentmonitor',
  [string]$ExpectedVersionName = '1.0.8',
  [int]$ExpectedVersionCode = 9,
  [string]$AaptPath,
  [string]$ApkSignerPath
)

$ErrorActionPreference = 'Stop'

function Resolve-AndroidTool {
  param(
    [Parameter(Mandatory = $true)][string]$ToolName,
    [string]$ExplicitPath
  )

  if ($ExplicitPath) {
    if (-not (Test-Path -LiteralPath $ExplicitPath)) {
      throw "Android tool was not found: $ExplicitPath"
    }
    return (Resolve-Path -LiteralPath $ExplicitPath).Path
  }

  $sdkRoots = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -Unique
  foreach ($sdkRoot in $sdkRoots) {
    $tool = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'build-tools') -Filter $ToolName -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($tool) { return $tool.FullName }
  }

  $command = Get-Command $ToolName -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Unable to locate $ToolName. Set ANDROID_HOME/ANDROID_SDK_ROOT or pass an explicit path."
}

$resolvedApk = (Resolve-Path -LiteralPath $ApkPath -ErrorAction Stop).Path
$aapt = Resolve-AndroidTool -ToolName 'aapt.exe' -ExplicitPath $AaptPath
$apksigner = Resolve-AndroidTool -ToolName 'apksigner.bat' -ExplicitPath $ApkSignerPath

$badging = (& $aapt dump badging $resolvedApk | Out-String)
if ($LASTEXITCODE -ne 0) { throw "aapt could not inspect $resolvedApk" }

$expectedPackagePattern = "package: name='$([regex]::Escape($ExpectedPackage))'"
if ($badging -notmatch $expectedPackagePattern) {
  throw "Unexpected APK package. Expected $ExpectedPackage."
}
if ($badging -notmatch "versionCode='$ExpectedVersionCode'") {
  throw "Unexpected APK version code. Expected $ExpectedVersionCode."
}
if ($badging -notmatch "versionName='$([regex]::Escape($ExpectedVersionName))'") {
  throw "Unexpected APK version name. Expected $ExpectedVersionName."
}
if ($badging -notmatch "application-label:") {
  throw "APK application label is missing."
}

$certificate = (& $apksigner verify --verbose --print-certs $resolvedApk | Out-String)
if ($LASTEXITCODE -ne 0) { throw "apksigner rejected the APK signature." }
if ($certificate -match '(?i)Android Debug|debug.keystore|CN=Android Debug') {
  throw 'Debug signing certificate detected; release distribution is forbidden.'
}
if ($certificate -notmatch '(?i)Verified using v[123] scheme.*: true') {
  throw 'No verified Android APK signature scheme was reported.'
}

Write-Output "Release APK verified: $resolvedApk"
Write-Output "Package: $ExpectedPackage | versionName: $ExpectedVersionName | versionCode: $ExpectedVersionCode"
Write-Output 'Certificate: non-debug and verified by apksigner'
