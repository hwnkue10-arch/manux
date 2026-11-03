@echo off
setlocal
cd /d "%~dp0"
title MANUX Air Mouse

:: Clear any inherited electron node runner environment variable
set ELECTRON_RUN_AS_NODE=

echo ===================================================================
echo     MANUX Air Mouse - Desktop App
echo ===================================================================
echo.
echo [Starting] Launching MANUX Air Mouse Desktop App...
echo.
echo  * Control Paradigm:
echo    1. [Pointer Move]: Index tip (LM 8) tracking with jitter filter
echo    2. [Left Click / Drag]: Thumb + Middle touch (instant double-click)
echo    3. [Right Click]: Thumb + Ring touch (independent buttons)
echo    4. [Phone Touch Scroll]: Index + Middle V-sign flick up to scroll down
echo    5. [Rest / Clutch]: Fist stops all tracking and inputs
echo.
echo  * Shortcuts:
echo    - F11: Toggle Fullscreen Transparent HUD Overlay
echo    - Esc: Return to Windowed Mode
echo    - Ctrl + Alt + M: Emergency Stop Mouse Control
echo.

if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" desktop\main.mjs
) else (
    call npm run desktop
)

if errorlevel 1 (
    echo.
    echo [Fallback] Opening Web Browser Practice Mode...
    start http://127.0.0.1:4173/#mouse
    call npm start
)

pause
