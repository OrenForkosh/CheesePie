# Requires PowerShell 5+/7+
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log($msg) { Write-Host "[start] $msg" }
function Write-Err($msg) { Write-Error "[start] $msg" }

# Repo root (script directory's parent)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir '..')
Set-Location $RootDir

# Choose Python (allow override via $env:PYTHON)
$py = if ($env:PYTHON) { $env:PYTHON } elseif (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { $null }
if (-not $py) { Write-Err 'Python not found. Install Python 3.10/3.11 and retry.'; exit 1 }
Write-Log "Using Python: $py"

# Create/activate venv
$VenvDir = Join-Path $RootDir '.venv'
if (-not (Test-Path (Join-Path $VenvDir 'Scripts' 'Activate.ps1'))) {
  Write-Log 'Creating virtual environment in .venv ...'
  & $py -m venv $VenvDir
}

. (Join-Path $VenvDir 'Scripts' 'Activate.ps1')
Write-Log "Venv: $env:VIRTUAL_ENV"

# Ensure pip and install requirements
& python -m pip --version | Out-Null
try { & python -m pip install --upgrade pip 1>$null 2>$null } catch { }
if (Test-Path (Join-Path $RootDir 'requirements.txt')) {
  Write-Log 'Installing requirements from requirements.txt ...'
  & python -m pip install -r requirements.txt
} else {
  Write-Log 'requirements.txt not found; skipping install'
}

# Optional: warn about MATLAB engine if enabled
try {
  $cfgPath = if ($env:CHEESEPIE_CONFIG) { $env:CHEESEPIE_CONFIG } else { Join-Path $RootDir 'config.json' }
  $cfg = Get-Content -Raw -Path $cfgPath | ConvertFrom-Json
  $m = $cfg.matlab
  if ($m -and $m.enabled -and ($m.mode -as [string]).Trim() -eq 'engine') {
    try { python - << 'PY'
try:
    import matlab.engine
    print('[start] MATLAB Engine import: OK')
except Exception as e:
    print('[start] NOTE: MATLAB Engine enabled in config, but not importable:', e)
    print('[start]       If you plan to use MATLAB features, run:')
    print('[start]         scripts/setup_matlab_engine.sh (on macOS/Linux)')
PY
    } catch { }
  }
} catch { }

# Run the app
if (-not $env:PORT) { $env:PORT = '8000' }
Write-Log "Starting app on http://127.0.0.1:$($env:PORT) ..."
& python app.py

