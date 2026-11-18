param([string]$JavaHome, [switch]$DownloadTestDependency)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $JavaHome) { $JavaHome = $env:JAVA_HOME }
if (-not $JavaHome) { throw 'Pass -JavaHome pointing to a JDK 17 or newer.' }
$java = Join-Path $JavaHome 'bin/java.exe'
$javac = Join-Path $JavaHome 'bin/javac.exe'
$keytool = Join-Path $JavaHome 'bin/keytool.exe'
$json = Join-Path $root '.toolchain/json-test.jar'
if ($DownloadTestDependency -and -not (Test-Path -LiteralPath $json)) {
  New-Item -ItemType Directory -Path (Split-Path $json) -Force | Out-Null
  Invoke-WebRequest 'https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.jar' -OutFile $json -TimeoutSec 120
}
if (-not (Test-Path -LiteralPath $json)) { throw 'Run with -DownloadTestDependency to fetch the pinned JVM test-only JSON library.' }
if ((Get-FileHash -LiteralPath $json -Algorithm SHA256).Hash -ne '3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796') { throw 'Test dependency checksum mismatch.' }
$testRoot = Join-Path $root ('build/transport-test-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$keyStore = Join-Path $testRoot 'fixture.p12'
& $keytool -genkeypair -alias fixture -storetype PKCS12 -keystore $keyStore -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 2 -dname 'CN=localhost' -ext 'SAN=dns:localhost'
if ($LASTEXITCODE -ne 0) { throw 'Local test TLS key generation failed.' }
& $javac -encoding UTF-8 -cp $json -d $testRoot (Join-Path $root 'src/cloud/qingyou/mail/MailTransport.java') (Join-Path $root 'test/TransportTest.java') (Join-Path $root 'src/cloud/qingyou/mail/ServerLicense.java') (Join-Path $root 'test/ServerLicenseTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Transport test compilation failed.' }
& $java -cp ($testRoot + [IO.Path]::PathSeparator + $json) cloud.qingyou.mail.ServerLicenseTest
if ($LASTEXITCODE -ne 0) { throw 'Server license boundary tests failed.' }
& $java -cp ($testRoot + [IO.Path]::PathSeparator + $json) cloud.qingyou.mail.TransportTest $keyStore
if ($LASTEXITCODE -ne 0) { throw 'Transport tests failed.' }
