@echo off
chcp 65001 >nul
title MANUX Air Mouse Prototype
cd /d "%~dp0"

echo ===================================================================
echo     MANUX Air Mouse Prototype - Transparent Screen HUD Overlay
echo ===================================================================
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
echo [RUN] Windows Air Mouse Desktop App 실행 중...
echo.
echo  * 조작 패러다임:
echo    1. [👆 포인터 이동]: 검지 끝(LM 8)을 모니터 화면 전체에 직접 1:1 매핑
echo    2. [🤏 좌클릭 & 드래그]: 엄지 + 검지 닿으면 좌클릭 누름 유지 (100%% 드래그)
echo    3. [👆 우클릭]: 엄지 + 중지 닿으면 우클릭
echo    4. [✌️ 폰 터치 스크롤]: 검지+중지 V자로 위로 그으면 아래 스크롤, 주먹 쥐어 손 떼기
echo    5. [✊ 휴식]: 주먹 쥐거나 손을 편하게 내리면 제어 정지
echo.
echo  * 바로가기 키:
echo    - F11: 화면 투명 HUD 오버레이 토글 (아이 트래커 방식)
echo    - Esc: 창 모드로 복귀
echo    - Ctrl + Alt + M: 언제든 즉시 비상 정지
echo.

call npx electron desktop\main.mjs
if errorlevel 1 (
    echo.
    echo [INFO] Falling back to Web Browser Practice Mode...
    start http://127.0.0.1:4173/#mouse
    call npm start
)
