@echo off
chcp 65001 >nul
title MANUX Ergonomic Air Mouse
cd /d "%~dp0"

echo ==========================================================
echo       MANUX Ergonomic Air Mouse
echo ==========================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not found.
    echo Please install Node.js LTS from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\@mediapipe\tasks-vision" (
    echo [SETUP] Installing vision dependencies...
    call npm install --ignore-scripts
)

if not exist "public\models\gesture_recognizer.task" (
    echo [SETUP] Downloading gesture recognition model...
    call node scripts\setup.mjs
)

echo.
echo [RUN] Launching Windows Air Mouse Desktop App...
echo       - Emergency Stop: Ctrl + Alt + M or Esc
echo.

call npx electron desktop\main.mjs
if errorlevel 1 (
    echo.
    echo [INFO] Falling back to Web Browser Practice Mode...
    start http://127.0.0.1:4173/#mouse
    call npm start
)

