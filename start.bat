@echo off
REM Dobbeltklikk denne for aa starte Stat19-assistenten. Lukk vinduet for aa stoppe.
cd /d "%~dp0app" || exit /b 1

if not exist node_modules (
  echo Foerste gang: kjoerer oppsett...
  node "%~dp0setup.mjs" --yes || exit /b 1
)

start "" http://localhost:5178
echo Starter... nettleseren aapnes paa http://localhost:5178
call npm run dev
