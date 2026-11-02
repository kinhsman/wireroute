@echo off
rem Removes the WireRoute helper. Your extension settings stay.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Remove
pause
