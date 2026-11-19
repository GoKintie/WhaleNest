$ErrorActionPreference = "Stop"

$appDir = $PSScriptRoot
$ws = Split-Path $appDir -Parent
$buildDir = [IO.Path]::GetFullPath((Join-Path $appDir "build"))
$resDir = Join-Path $appDir "res\drawable"
$jdkBin = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME "bin" } else { "C:\Program Files\Java\jdk-21\bin" }
$javac = Join-Path $jdkBin "javac.exe"
$java = Join-Path $jdkBin "java.exe"
if (-not $env:ANDROID_SDK_ROOT) { throw "请设置 ANDROID_SDK_ROOT 为已安装的 Android SDK 目录" }
$btDir = Get-ChildItem (Join-Path $env:ANDROID_SDK_ROOT "build-tools") -Directory | Where-Object { Test-Path (Join-Path $_.FullName "aapt2.exe") } | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
$androidJar = Get-ChildItem (Join-Path $env:ANDROID_SDK_ROOT "platforms") -Filter android.jar -Recurse | Select-Object -First 1 -ExpandProperty FullName
$aapt2 = Join-Path $btDir "aapt2.exe"
$zipalign = Join-Path $btDir "zipalign.exe"
$d8Jar = Join-Path $btDir "lib\d8.jar"
$apksignerJar = Join-Path $btDir "lib\apksigner.jar"
foreach ($tool in @($javac,$java,$aapt2,$zipalign,$d8Jar,$apksignerJar,$androidJar)) { if (-not (Test-Path -LiteralPath $tool)) { throw "缺少构建依赖: $tool" } }
if (-not $buildDir.StartsWith([IO.Path]::GetFullPath($appDir)+[IO.Path]::DirectorySeparatorChar)) { throw "构建输出目录越界" }
if (Test-Path -LiteralPath $buildDir) { Remove-Item -LiteralPath $buildDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$buildDir\gen", "$buildDir\classes", "$buildDir\res_compiled", $resDir | Out-Null

# 1. 将肥鱼 avatar.jpg 转换为 192x192 PNG 图标 res/drawable/ic_launcher.png
Add-Type -AssemblyName System.Drawing
$srcAvatar = Join-Path $ws "bridge\assets\avatar.jpg"
$iconPath = Join-Path $resDir "ic_launcher.png"
$img = [System.Drawing.Image]::FromFile($srcAvatar)
$bmp = New-Object System.Drawing.Bitmap(192, 192)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, 192, 192)
$g.Dispose()
$img.Dispose()
$bmp.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "[1/6] Icon generated: $iconPath"

# 2. aapt2 compile & link
& $aapt2 compile --dir (Join-Path $appDir "res") -o "$buildDir\res_compiled\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

& $aapt2 link -o "$buildDir\unaligned.apk" `
  --manifest (Join-Path $appDir "AndroidManifest.xml") `
  -I $androidJar `
  --java "$buildDir\gen" `
  "$buildDir\res_compiled\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }
Write-Output "[2/6] aapt2 compile & link OK"

# 3. javac 编译 MainActivity.java + R.java
$rJava = Get-ChildItem "$buildDir\gen" -Recurse -Filter "R.java" | Select-Object -ExpandProperty FullName
$mainJava = @(Get-ChildItem (Join-Path $appDir "src") -Recurse -Filter "*.java" | Select-Object -ExpandProperty FullName)
& $javac -encoding UTF-8 -source 1.8 -target 1.8 -bootclasspath $androidJar -d "$buildDir\classes" $rJava $mainJava
if ($LASTEXITCODE -ne 0) { throw "javac failed" }
Write-Output "[3/6] javac compilation OK"

# 4. jar + d8 将 .class 转为 classes.dex 并写入 APK
$jarExe = Join-Path $jdkBin "jar.exe"
& $jarExe cf "$buildDir\classes.jar" -C "$buildDir\classes" .
& $java -cp $d8Jar com.android.tools.r8.D8 --lib $androidJar --min-api 24 --output $buildDir "$buildDir\classes.jar"
if ($LASTEXITCODE -ne 0) { throw "d8 dexing failed" }

& $jarExe uf "$buildDir\unaligned.apk" -C $buildDir classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar uf classes.dex failed" }
Write-Output "[4/6] classes.dex packaged into APK"

# 5. zipalign 4字节对齐
& $zipalign -f -p 4 "$buildDir\unaligned.apk" "$buildDir\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

# 6. 使用用户已有签名密钥；私钥与密码不进入发布包。
$keystore = $env:ANDROID_KEYSTORE_PATH
if (-not $keystore -or -not (Test-Path -LiteralPath $keystore)) { throw "请设置 ANDROID_KEYSTORE_PATH" }
if (-not $env:ANDROID_STORE_PASSWORD) { throw "请设置 ANDROID_STORE_PASSWORD" }
if (-not $env:ANDROID_KEY_ALIAS) { throw "请设置 ANDROID_KEY_ALIAS" }
$finalApk = Join-Path $ws "鲸鱼窝-v3.6.5.apk"
& $java -jar $apksignerJar sign --ks $keystore --ks-key-alias $env:ANDROID_KEY_ALIAS --ks-pass env:ANDROID_STORE_PASSWORD --key-pass env:ANDROID_STORE_PASSWORD --out $finalApk "$buildDir\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& $java -jar $apksignerJar verify --verbose $finalApk
if ($LASTEXITCODE -ne 0) { throw "APK verification failed" }
Write-Output "[6/6] APK built and verified: $finalApk"
