# 내 PC(PowerShell)에서 실행: powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
# 현재 폴더의 게임 파일을 묶어 Oracle 서버에 올리고 remote-deploy.sh 를 실행합니다.
param(
  [string]$Server = '137.131.50.244',
  [string]$User = 'ubuntu',
  [string]$Key = "$env:USERPROFILE\.ssh\oracle_ig"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP 'las-vegas-release.tar.gz'
$script = Join-Path $env:TEMP 'las-vegas-remote-deploy.sh'

# 서버에서 실행할 스크립트는 줄바꿈을 LF 로 맞춥니다.
$text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'remote-deploy.sh')) -replace "`r`n", "`n"
[IO.File]::WriteAllText($script, $text, (New-Object Text.UTF8Encoding $false))

Write-Host '1/3 게임 파일 묶는 중...'
& tar.exe -czf $tmp -C $root server.js package.json package-lock.json public
if ($LASTEXITCODE -ne 0) { throw 'tar 실패' }

Write-Host '2/3 서버로 업로드 중...'
& scp.exe -i $Key -o BatchMode=yes $tmp $script "${User}@${Server}:~/"
if ($LASTEXITCODE -ne 0) { throw 'scp 실패' }

Write-Host '3/3 서버에서 배포 실행 중...'
& ssh.exe -i $Key -o BatchMode=yes "${User}@${Server}" 'sudo bash ~/las-vegas-remote-deploy.sh ~/las-vegas-release.tar.gz && rm -f ~/las-vegas-release.tar.gz ~/las-vegas-remote-deploy.sh'
if ($LASTEXITCODE -ne 0) { throw '서버 배포 실패' }
