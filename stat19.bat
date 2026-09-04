@echo off
REM Stat19-assistenten paa kommandolinja. Kjoer stat19 --help
cd /d "%~dp0app" || exit /b 1
if not exist node_modules (
  echo Avhengighetene mangler - kjoer "node setup.mjs" forst. 1>&2
  exit /b 1
)
npx --no-install tsx server/cli.ts %*
