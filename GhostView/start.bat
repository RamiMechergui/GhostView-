@echo off
cd /d "%~dp0"
echo Starting GhostView - Zero-Tracking Browser
echo.
echo Features:
echo  - No cookies, history, cache, or local storage
echo  - All data wiped every 60 seconds
echo  - Memory-wiped on close
echo  - Tracker headers stripped
echo  - All permissions denied by default
echo.
npm start
