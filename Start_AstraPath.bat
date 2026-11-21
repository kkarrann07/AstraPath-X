@echo off
setlocal
cd /d "%~dp0"
title AstraPath-X Launcher

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import sys; raise SystemExit(not ((3,12) <= sys.version_info[:2] <= (3,14)))" 2>nul
    if not errorlevel 1 goto venv
)

where py >nul 2>&1
if not errorlevel 1 (
    py -3.13 -c "pass" >nul 2>&1
    if not errorlevel 1 goto python313
    py -3.12 -c "pass" >nul 2>&1
    if not errorlevel 1 goto python312
    py -3.14 -c "pass" >nul 2>&1
    if not errorlevel 1 goto python314
)

where python >nul 2>&1
if not errorlevel 1 (
    python -c "import sys; raise SystemExit(not ((3,12) <= sys.version_info[:2] <= (3,14)))" >nul 2>&1
    if not errorlevel 1 goto pathpython
)

echo AstraPath-X requires Python 3.12, 3.13, or 3.14.
echo Install Python using the official graphical installer, then double-click this file again.
echo https://www.python.org/downloads/windows/
pause
exit /b 1

:venv
".venv\Scripts\python.exe" -m astrapath.launcher
goto done
:python313
py -3.13 -m astrapath.launcher
goto done
:python312
py -3.12 -m astrapath.launcher
goto done
:python314
py -3.14 -m astrapath.launcher
goto done
:pathpython
python -m astrapath.launcher

:done
if errorlevel 1 (
    echo.
    echo AstraPath-X could not start. See the message above.
    pause
    exit /b 1
)
exit /b 0
