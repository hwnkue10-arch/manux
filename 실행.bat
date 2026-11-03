@echo off
chcp 65001 >nul
title MANUX 인체공학 에어마우스
cd /d "%~dp0"

echo ==========================================================
echo       MANUX 인체공학 에어마우스 (Air Mouse)
echo ==========================================================
echo.

:: 1. Node.js 설치 확인
where node >nul 2>&1
if errorlevel 1 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 Node.js LTS 버전을 설치한 뒤 다시 실행해 주세요.
    echo.
    pause
    exit /b 1
)

:: 2. 필수 라이브러리 확인
if not exist "node_modules\@mediapipe\tasks-vision" (
    echo [설치] 필수 비전 패키지를 설치합니다...
    call npm install --ignore-scripts
)

:: 3. 비전 AI 모델 파일 확인
if not exist "public\models\gesture_recognizer.task" (
    echo [다운로드] 손 관절 인식 AI 모델을 준비합니다...
    call node scripts\setup.mjs
)

:: 4. 데스크톱 앱 실행 (Electron)
echo.
echo [실행] Windows 에어마우스 데스크톱 앱을 실행합니다...
echo        - 비상 정지: Ctrl + Alt + M 또는 Esc
echo.

call npx electron desktop\main.mjs
if errorlevel 1 (
    echo.
    echo [안내] 데스크톱 실행에 실패하여 웹 브라우저 연습 모드로 시작합니다...
    start http://127.0.0.1:4173/#mouse
    call npm start
)
