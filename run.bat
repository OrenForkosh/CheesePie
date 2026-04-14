@echo off
setlocal ENABLEDELAYEDEXPANSION

rem Change to the directory of this script
rem cd /d "%~dp0"

echo Pick a Python launcher
set "PY_EXE="
where py >nul 2>nul && set "PY_EXE=py -3"
if not defined PY_EXE set "PY_EXE=python"
echo Using Python: %PY_EXE%

echo Create venv if missing
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment (.venv)
  %PY_EXE% -m venv .venv || goto :venv_fail
)

echo Activate venv
call ".venv\Scripts\activate.bat" || goto :venv_fail

echo Upgrade pip quietly
python -m pip install --upgrade pip >nul 2>nul

echo Install requirements if present
if exist requirements.txt (
  echo Installing requirements
  pip install -r requirements.txt || goto :pip_fail
)

echo Setting helpful environment vars
set "FLASK_ENV=development"
set "PYTHONUTF8=1"

echo Starting CheesePie at http://localhost:5000
echo (Close this window to stop)
python app.py
goto :eof

:venv_fail
echo.
echo [ERROR] Failed to create or activate the virtual environment.
pause
exit /b 1

:pip_fail
echo.
echo [ERROR] Failed to install Python requirements.
pause
exit /b 1

