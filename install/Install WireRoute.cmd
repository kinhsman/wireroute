@echo off
rem Installs the WireRoute helper (no admin rights needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
