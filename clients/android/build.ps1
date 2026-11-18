param([string]$JavaHome, [switch]$DownloadTools)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$toolchain = Join-Path $root '.toolchain'
if (-not $JavaHome) { $JavaHome = $env:JAVA_HOME }
if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) {
  $jdk = Get-ChildItem 'C:/Program Files/Java' -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/javac.exe') } | Sort-Object Name -Descending | Select-Object -First 1
  if ($jdk) { $JavaHome = $jdk.FullName }
}
if (-not $JavaHome) { throw 'Install JDK 17 or newer, or pass -JavaHome.' }
$java = Join-Path $JavaHome 'bin/java.exe'
$javac = Join-Path $JavaHome 'bin/javac.exe'
$keytool = Join-Path $JavaHome 'bin/keytool.exe'
$platform = Join-Path $toolchain 'platforms/android-35/android.jar'
$tools = Join-Path $toolchain 'build-tools/android-15'
if ($DownloadTools) {
  New-Item -ItemType Directory -Path $toolchain -Force | Out-Null
  # Pinned from Google's repository2-1.xml. The SDK license applies to these tools.
  $packages = @(
    @{File='platform-35_r02.zip'; SHA1='0bb560a90a7a2cbd0dd8348224d518b638fe7949'; Destination='platforms'; Check=$platform},
    @{File='build-tools_r35_windows.zip'; SHA1='af059bb67cf7786f45ee0db85e2d24985df1b4b6'; Destination='build-tools'; Check=(Join-Path $tools 'aapt2.exe')}
  )
  foreach ($package in $packages) {
    if (Test-Path -LiteralPath $package.Check) { continue }
    $zip = Join-Path $toolchain $package.File
    if (-not (Test-Path -LiteralPath $zip)) { Invoke-WebRequest -Uri ('https://dl.google.com/android/repository/' + $package.File) -OutFile $zip -TimeoutSec 300 }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA1).Hash -ne $package.SHA1) { throw ('SDK checksum mismatch: ' + $package.File) }
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $toolchain $package.Destination)
  }
}
if (-not (Test-Path -LiteralPath $platform) -or -not (Test-Path -LiteralPath (Join-Path $tools 'aapt2.exe'))) { throw 'SDK missing. Run with -DownloadTools to fetch pinned official Android SDK files.' }
$build = Join-Path $root ('build/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
$assets = Join-Path $build 'assets'
New-Item -ItemType Directory -Force $classes,$dex,$assets,(Join-Path $root 'dist'),(Join-Path $root '.signing') | Out-Null
$shared = Join-Path $root '../ui'
foreach ($file in @('index.html','app.js','app.css','model.js')) { if (-not (Test-Path -LiteralPath (Join-Path $shared $file))) { throw ('Shared UI missing: ' + $file) } }
# Copy runtime files directly: test browser profiles may be open and must never
# enter the build, even temporarily. Keep this allowlist aligned with Windows.
$uiAssets = Join-Path $assets 'ui'
New-Item -ItemType Directory -Path $uiAssets | Out-Null
Get-ChildItem -LiteralPath $shared -File | Where-Object { $_.Extension -match '^\.(html|css|js|svg|png|ico|woff2)$' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $uiAssets $_.Name)
}
Copy-Item -LiteralPath (Join-Path $root 'bridge.js') -Destination (Join-Path $assets 'ui/bridge.js') -Force
$sources = @(Get-ChildItem (Join-Path $root 'src') -Filter '*.java' -Recurse | ForEach-Object {$_.FullName})
& $javac -encoding UTF-8 --release 8 -classpath $platform -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'Java compile failed' }
$classFiles = @(Get-ChildItem $classes -Filter '*.class' -Recurse | ForEach-Object {$_.FullName})
& $java -cp (Join-Path $tools 'lib/d8.jar') com.android.tools.r8.D8 --min-api 26 --lib $platform --output $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw 'DEX compile failed' }
Push-Location $root
try {
  & (Join-Path $tools 'aapt2.exe') compile --dir res -o ([IO.Path]::GetRelativePath($root,(Join-Path $build 'resources.zip')))
  if ($LASTEXITCODE -ne 0) { throw 'Resource compile failed' }
} finally { Pop-Location }
$unsigned = Join-Path $build 'unsigned.apk'
Push-Location $root
try {
  & (Join-Path $tools 'aapt2.exe') link -o ([IO.Path]::GetRelativePath($root,$unsigned)) --manifest AndroidManifest.xml -I ([IO.Path]::GetRelativePath($root,$platform)) ([IO.Path]::GetRelativePath($root,(Join-Path $build 'resources.zip')))
  if ($LASTEXITCODE -ne 0) { throw 'APK link failed' }
} finally { Pop-Location }
Add-Type -AssemblyName System.IO.Compression
$zipArchive = [IO.Compression.ZipFile]::Open($unsigned,[IO.Compression.ZipArchiveMode]::Update)
try {
  foreach ($file in (Get-ChildItem $dex -Filter '*.dex')) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive,$file.FullName,$file.Name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null }
  # Windows AAPT2 may keep backslashes in recursive asset names. Android's
  # AssetManager requires slash-separated ZIP paths, so add assets explicitly.
  foreach ($file in (Get-ChildItem $assets -File -Recurse)) {
    $entryName = 'assets/' + [IO.Path]::GetRelativePath($assets,$file.FullName).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive,$file.FullName,$entryName,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zipArchive.Dispose() }
$aligned = Join-Path $build 'aligned.apk'
Push-Location $root
try {
  & (Join-Path $tools 'zipalign.exe') -f 4 ([IO.Path]::GetRelativePath($root,$unsigned)) ([IO.Path]::GetRelativePath($root,$aligned))
  if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed' }
} finally { Pop-Location }
$keystore = Join-Path $root '.signing/debug.keystore'
if (-not (Test-Path -LiteralPath $keystore)) {
  & $keytool -genkeypair -keystore $keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Qingyou Development,C=CN'
  if ($LASTEXITCODE -ne 0) { throw 'Debug signing key generation failed' }
}
[xml]$manifestXml = Get-Content -LiteralPath (Join-Path $root 'AndroidManifest.xml') -Raw
$clientVersion = $manifestXml.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
if ($clientVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Android version' }
$output = Join-Path $root "dist/Qingyou-Android-$clientVersion-test.apk"
& $java -jar (Join-Path $tools 'lib/apksigner.jar') sign --ks $keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out $output $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
& $java -jar (Join-Path $tools 'lib/apksigner.jar') verify --verbose --print-certs $output
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
$packaged = [IO.Compression.ZipFile]::OpenRead($output)
try {
  foreach ($file in (Get-ChildItem $assets -File -Recurse)) {
    $entryName = 'assets/' + [IO.Path]::GetRelativePath($assets,$file.FullName).Replace('\','/')
    $entry = $packaged.GetEntry($entryName)
    if ($null -eq $entry) { throw ('APK asset missing: ' + $entryName) }
    $stream = $entry.Open()
    try { $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
    if ($actual -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw ('APK asset mismatch: ' + $entryName) }
  }
  if (@($packaged.Entries | Where-Object { $_.FullName.Contains('\') }).Count) { throw 'APK contains invalid backslash paths.' }
} finally { $packaged.Dispose() }
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($output+'.sha256',$hash+'  '+[IO.Path]::GetFileName($output)+"`n")
Write-Output ('APK: ' + $output)
Write-Output ('SHA256: ' + $hash)
