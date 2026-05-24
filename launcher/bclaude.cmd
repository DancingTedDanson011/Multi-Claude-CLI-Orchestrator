@echo off
rem Thin wrapper for bclaude.ps1 — allows `bclaude` (no .ps1) on the command line.
rem Passes all args through. ExecutionPolicy bypass is scoped to this invocation only.
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0bclaude.ps1" %*
exit /b %ERRORLEVEL%
