@echo off
REM Dobbeltklikk denne for aa starte Stat19-assistenten. Ctrl+C for aa stoppe.
cd /d "%~dp0"
node start.mjs
if errorlevel 1 pause
