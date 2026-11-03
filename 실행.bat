@echo off
chcp 65001 >nul
title MANUX 에어 마우스 (Air Mouse)
cd /d "%~dp0"

echo ===================================================================
echo     MANUX 에어 마우스 - 모니터 투명 HUD 오버레이 시제품
echo ===================================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 Node.js LTS 버전을 설치한 뒤 다시 실행하세요.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\@mediapipe\tasks-vision" (
    echo [초기 설정] 손 추적 비전 패키지를 설치하고 있습니다...
    call npm install --ignore-scripts
)

if not exist "public\models\gesture_recognizer.task" (
    echo [초기 설정] 로컬 오프라인 인식 모델을 다운로드하고 있습니다...
    call node scripts\setup.mjs
)

echo.
echo [실행] Windows 에어 마우스 데스크톱 앱을 시작합니다...
echo.
echo  * 조작 패러다임 (인체공학 제스처):
echo    1. [👆 포인터 이동 (제스처 1)]: 검지만 펴고 이동 (0, 2, 3, 4, 5번 등 다른 모든 모양은 100%% 휴식)
echo    2. [🤏 제로딥 좌클릭 드래그]: 검지는 가만히 두고 엄지를 검지 옆마디(DIP)에 톡 닿으면 좌클릭 (흔들림 0%%)
echo    3. [👆 우클릭]: 중지를 펴서 엄지와 맞닿으면 우클릭 (제스처 1 중지 말림 시 오인식 차단)
echo    4. [✌️ 폰 터치 스크롤 (제스처 2)]: 검지+중지 V자로 위로 그으면 아래 스크롤, 주먹 쥐어 손 떼기
echo    5. [✊ 휴식 / 대기]: 제스처 1, 2, 핀치 이외의 모든 모양은 100%% 입력 휴식
echo.
echo  * 단축키 안내:
echo    - F11: 화면 투명 HUD 오버레이 모드 토글 (아이 트래커 방식)
echo    - Esc: 일반 창 모드로 복귀
echo    - Ctrl + Alt + M: 언제든 즉시 비상 정지 (글로벌 핫키)
echo.

call npx electron desktop\main.mjs
if errorlevel 1 (
    echo.
    echo [안내] 브라우저 연습 모드로 전환합니다...
    start http://127.0.0.1:4173/#mouse
    call npm start
)

