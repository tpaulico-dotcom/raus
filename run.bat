@echo off
chcp 65001 >nul
setlocal EnableExtensions
title RAUS - lancement
cd /d "%~dp0"
set "PYTHONPATH="

set "BACKEND=%~dp0backend"
set "FRONTEND=%~dp0frontend"
set "VENV=%BACKEND%\.venv"
set "PY=%VENV%\Scripts\python.exe"

echo ==========================================================
echo    RAUS - Reseau Actif d'Utilite Sociale
echo    Moteur 3D monde temps reel (OpenStreetMap)
echo    Backend FastAPI (SQLite local) + frontend Vite
echo ==========================================================
echo.

REM ---- 0. Nettoyage des ports : on repart toujours propre ----
REM Un ancien backend ou un ancien Vite qui survit bloque le demarrage. On les arrete
REM nous-memes, au lieu de demander de fermer une fenetre a la main.
echo [0/3] Nettoyage des ports 8001 (backend) et 5173 (frontend)...
call :free_port 8001
call :free_port 5173
ping -n 3 127.0.0.1 >nul
echo.

REM ---- 1. Environnement Python du backend ----
if exist "%PY%" (
  "%PY%" -c "import fastapi, httpx, PIL, shapely, mapbox_vector_tile" >nul 2>&1
  if not errorlevel 1 (
    echo [1/3] Environnement Python pret.
    goto :front
  )
)

echo [1/3] Preparation de l'environnement Python (une seule fois, environ 3 min)...
REM Le lanceur "py" peut pointer sur une installation cassee : on teste chaque candidat pour de vrai.
call :try_python "py -3.14"
call :try_python "py -3.13"
call :try_python "py -3.12"
call :try_python "py -3.11"
call :try_python "py -3.10"
call :try_python "%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
call :try_python "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
call :try_python "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
call :try_python "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
call :try_python "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
call :try_python "C:\Python312\python.exe"
call :try_python "C:\Python310\python.exe"
call :try_python "python"

if not exist "%PY%" goto :no_python
for /f "tokens=*" %%v in ('"%PY%" -V 2^>^&1') do echo       Version utilisee : %%v
echo       Installation des dependances Python...
"%PY%" -m pip install --disable-pip-version-check -q --upgrade pip >nul 2>&1
"%PY%" -m pip install --disable-pip-version-check -q -r "%BACKEND%\requirements.txt"
if errorlevel 1 (
  echo       Bornes de version non satisfaites sur ce Python : nouvel essai sans contrainte...
  "%PY%" -m pip install --disable-pip-version-check -q fastapi uvicorn httpx pydantic python-dotenv pillow mapbox-vector-tile shapely
  if errorlevel 1 goto :error
)

:front
REM ---- 2. Dependances du frontend ----
if exist "%FRONTEND%\node_modules" goto :deps_ok
echo [2/3] Installation des dependances JavaScript (npm install, environ 3 min)...
pushd "%FRONTEND%"
call npm install --no-audit --no-fund --legacy-peer-deps
if errorlevel 1 (popd & goto :error)
popd
goto :start_all

:deps_ok
echo [2/3] Dependances JavaScript pretes.

:start_all
echo [3/3] Demarrage du backend (port 8001) et du frontend (port 5173)...
start "RAUS - backend" /D "%BACKEND%" cmd /k ""%PY%" -m uvicorn server:app --host 127.0.0.1 --port 8001"
ping -n 4 127.0.0.1 >nul
start "RAUS - frontend" /D "%FRONTEND%" cmd /k "npm run dev"
echo.
echo    Backend  : http://127.0.0.1:8001/api/    (laisser cette fenetre ouverte)
echo    Frontend : http://localhost:5173
echo.
echo    Fermez les deux fenetres noires "backend" et "frontend" pour tout arreter.
ping -n 8 127.0.0.1 >nul
start "" http://localhost:5173
echo.
echo Bonne exploration.
pause
exit /b 0

REM ---- Sous-programme : libere un port en arretant le processus qui l'ecoute ----
:free_port
set "PORT=%~1"
set "TROUVE="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  set "TROUVE=1"
  echo       port %PORT% occupe par le PID %%A : arret du processus.
  taskkill /F /PID %%A >nul 2>&1
)
if not defined TROUVE echo       port %PORT% libre.
exit /b 0

REM ---- Sous-programme : essaie un Python et cree le venv s'il fonctionne ----
REM (les chemins avec espaces ne sont pas geres : inutile sur cette machine)
:try_python
if exist "%PY%" exit /b 0
%~1 -c "import sys" >nul 2>&1
if errorlevel 1 exit /b 0
%~1 -m venv "%VENV%" >nul 2>&1
if not exist "%PY%" (
  rmdir /s /q "%VENV%" >nul 2>&1
  exit /b 0
)
"%PY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
  rmdir /s /q "%VENV%" >nul 2>&1
  exit /b 0
)
echo       Python retenu : %~1
exit /b 0

:no_python
echo.
echo [X] Aucun Python fonctionnel n'a ete trouve sur cette machine.
echo     Installez Python 3.11 ou plus recent : https://www.python.org/downloads/
echo     (cochez "Add python.exe to PATH" pendant l'installation)
pause
exit /b 1

:error
echo.
echo [X] Echec de l'installation des dependances. Verifiez votre connexion reseau.
pause
exit /b 1
