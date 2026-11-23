@echo off
rem One-time laptop setup for logi-sync: copies the script, starts it at logon and starts it now.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0logi-sync.ps1" install
pause
