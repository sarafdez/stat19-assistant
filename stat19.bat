@echo off
REM Stat19-assistenten paa kommandolinja. Kjoer stat19 --help
cd /d "%~dp0app"
if not exist node_modules (
  echo Avhengighetene mangler - kjoer "node setup.mjs" forst. 1>&2
  exit /b 1
)
REM Kompiler server/ til vanlig JavaScript og kjoer det under node.
REM tsx ville vaert enklere, men det driver esbuild, som starter en egen
REM esbuild.exe - den blokkeres av programkontroll (AppLocker) paa FHI-PC-er.
REM tsc er ren JavaScript. Bygget er inkrementelt, saa dette tar ~1 s naar
REM ingenting er endret, og kan aldri bli utdatert. Se tsconfig.server.json.
node node_modules\typescript\bin\tsc -p tsconfig.server.json 1>&2
if errorlevel 1 (
  echo Kompileringen feilet - se feilmeldingene over. 1>&2
  exit /b 1
)
node dist-server\cli.js %*
exit /b %errorlevel%
