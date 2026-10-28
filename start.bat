@echo off
setlocal
cd /d "%~dp0"
title Easy Drop

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node tunnel.js %*
if errorlevel 1 pause
