# MANUX · 인체공학 에어 마우스 (Ergonomic Air Mouse)

> **"손을 움직이면, 커서도 함께."**  
> 모니터 위에 손가락 좌표가 직접 떠오르는 **아이 트래커 방식 투명 HUD 오버레이**와 인체공학적 제스처로 조작하는 Windows 핸즈프리 에어 마우스 시제품입니다. 손목 터널 증후군(CTS)과 관절 피로를 최소화하기 위해 설계되었습니다.

---

## ⚡ 빠른 실행 (1-Click Run)

`manux` 폴더 안의 **`실행.bat`**를 더블클릭하면 모든 의존성 설치, 오프라인 인식 모델 다운로드, 앱 실행이 자동으로 처리됩니다.

```batch
실행.bat
```

> **요구사항**: Windows 10/11, Node.js (LTS), 일반 USB 웹캠 또는 노트북 내장 카메라

---

## 🚀 새로운 상호작용 패러다임 (Core Paradigm)

기존 웹캠 에어 마우스의 한계(미세 떨림, 클릭 시 커서 쏠림, 시선 분산, 어색한 자세 피로)를 해결하기 위해 **4가지 새로운 인터랙션 아키텍처**를 적용했습니다.

### 1. 모니터 투명 HUD 오버레이 (아이 트래커 방식)
* 작은 웹캠 창을 답답하게 쳐다볼 필요가 없습니다. 웹캠 영상은 백그라운드에서 투명 처리되며, **모니터 화면 전체에 검지(LM 8)·엄지(LM 4)·중지(LM 12) 네온 AR 포인트가 직접 오버레이**됩니다.
* Electron의 `setIgnoreMouseEvents(true, { forward: true })` 기술로 웹서핑, 문서 편집, 게임 등 모든 Windows 프로그램 위에서 투명하게 클릭이 관통됩니다.

### 2. 검지 포인터 1:1 직접 추적 & 사각지대 없는 콤팩트 활성 구역
* **검지(`LM 8`)는 오직 마우스 포인터 이동만 전담**하며, 클릭 동작에 전혀 관여하지 않으므로 클릭 시 커서가 튀는 현상(Click Dip)이 **물리적으로 0.00%**입니다.
* **사각지대 소멸 & 화면 이탈 방지**:
  * 손이 웹캠 화각 가장자리로 나가서 인식이 끊기던 문제를 해결하기 위해, 손이 가장 편안하게 움직일 수 있는 **중앙 안전 구역($X: [0.28, 0.72]$, $Y: [0.20, 0.68]$)을 모니터 100% 전체 화면으로 1:1 매핑**했습니다.
  * 손목이나 손가락 관절이 화면 모서리에 살짝 닿거나 벗어나더라도 에러로 튕기지 않고 부드럽게 좌표를 클램핑하여 추적을 이어갑니다.

### 3. 엄지 + 중지: 좌클릭 & 100% 신뢰성 연속 드래그
* **동작**: 검지로 대상을 조준한 채, **엄지(`LM 4`)와 중지(`LM 12`)를 맞닿으면 좌클릭 유지(Down)**가 활성화됩니다.
* 맞닿은 채로 손(검지)을 움직이면 창 이동, 파일 드래그앤드롭, 텍스트 블록 지정이 **100% 끊김 없이 유지**됩니다. 손가락을 떼는 순간 즉시 마우스 버튼이 해제됩니다.

### 4. 엄지 + 소지: 우클릭 & 주먹 오클릭 100% 원천 차단
* **동작**: **엄지(`LM 4`)와 소지(새끼손가락, `LM 20`)를 맞닿으면 우클릭**이 발동됩니다.
* **엄격한 접촉 판정**:
  * 핀치 인식 임계값을 $0.28$로 정밀화하여 손가락이 실제로 닿았을 때만 정확히 발동합니다.
  * **주먹(Fist) 상태 오클릭 100% 차단**: 검지가 펴져 있지 않거나 주먹을 쥐었을 때는 모든 클릭 판정을 원천 무효화하여, 주먹을 쥐면서 손가락들이 엄지와 뭉쳐도 가짜 클릭이 일체 발생하지 않습니다.

### 5. 제스처 2: 스마트폰 터치 & 손 떼기 스크롤 (Peace Sign)
* **스마트폰 터치 동기화**: 검지와 중지를 펴서 V자(Peace sign)를 만들면 그 자리에서 가상 터치 앵커가 생성됩니다.
* **위로 튕기면 아래로 스크롤**: 스마트폰 화면을 손가락으로 튕기듯, **두 손가락을 위로 그으면 화면이 아래로 스크롤**됩니다.
* **주먹 쥐어 손 떼기 (역스크롤 0%)**: 스크롤을 더 내리고 싶을 때 주먹을 살짝 쥐면 화면에서 손을 뗀 상태가 되어, 손을 아래로 원위치시켜도 반대 방향 스크롤이 전혀 발생하지 않습니다. 다시 V자를 펴서 위로 튕기면 연속 스크롤이 이어집니다.

---

## 🎮 제스처 조작 표

| 제스처 | HUD 피드백 | 기능 | 상세 동작 |
| :--- | :--- | :--- | :--- |
| **👆 검지 포인터** | 청록색(Cyan) 타겟 링 & 십자선 | **커서 이동** | 검지 끝(LM 8) 1:1 추적 (사각지대 없는 중앙 콤팩트 구역 매핑) |
| **🤏 엄지+중지 핀치** | 에메랄드(Emerald) 네온 레이저 | **좌클릭 & 연속 드래그** | 엄지+중지 맞닿으면 좌클릭 유지, 이동 시 100% 드래그 (검지 흔들림 0%) |
| **👆 엄지+소지 핀치** | 파란색(Blue) 네온 레이저 | **우클릭** | 엄지+새끼손가락 맞닿으면 우클릭 (주먹 쥐면 오클릭 100% 차단) |
| **✌️ 제스처 2** | 보라색(Purple) 트윈 가이드 | **스마트폰 터치 스크롤** | V자 편 채 위로 그으면 아래 스크롤, 주먹 쥐어 복귀 |
| **✊ 주먹 / 휴식** | HUD 회색 비활성 링 | **제어 휴식 (Rest)** | 주먹을 쥐거나 손을 책상에 내리면 모든 입력 일시 정지 |

---

## ⌨️ 단축키 안내 (Keyboard Shortcuts & Hotkeys)

| 단축키 | 적용 범위 | 설명 |
| :--- | :--- | :--- |
| **`F11`** | 앱 창 및 오버레이 | **화면 투명 HUD 오버레이 모드 토글** (모니터 전체 화면 AR 모드) |
| **`Esc`** | 앱 및 오버레이 | **일반 창 모드로 복귀** / 제어 일시 중지 |
| **`Ctrl + Alt + M`** | **Windows 전체 (글로벌)** | **비상 제어 중지 (Emergency Stop)** (어떤 프로그램 실행 중에도 즉시 마우스 권한 해제) |

---

## 🛠️ 기술 스택 (Tech Stack)

```text
[웹캠 비디오 입력] 
       │
       ▼
[MediaPipe Tasks Vision 1.2.0] ── 21개 3D 핸드 랜드마크 고속 추출
       │
       ▼
[AirMouseController] ── 지수 스무딩 · 포인터 탄도학 · 핀치 히스테리시스 · 스마트폰 스크롤 역학
       │
  ┌────┴────────────────────────┐
  ▼                             ▼
[HTML5 AR HUD Canvas]         [Electron IPC Bridge]
- 100vw x 100vh 투명 오버레이   - safe IPC token lease & watchdog
- 네온 글로우 렌더링           - win32 SendInput (C# P/Invoke)
- 플로팅 Frosted Glass 바      - 상대좌표 Move / Click / Wheel 주입
```

* **Frontend & UI Layer**:
  * Vanilla ES Modules (Zero Build Overhead)
  * HTML5 Canvas 2D Context (고성능 실시간 AR 네온 HUD 및 관절 시각화)
  * CSS3 Custom Properties & Glassmorphism (`backdrop-filter: blur`, frameless layout)
* **Vision & AI Engine**:
  * Google `@mediapipe/tasks-vision` (v1.2.0)
  * Hand Landmark Recognizer (21 Keypoints, 3D Normalized Coordinates, 온디바이스 로컬 추론)
* **Desktop Shell & Overlay**:
  * Electron (v45.2.1 / Chromium 120+ / Node.js 24)
  * Transparent Frameless BrowserWindow (`transparent: true`, `backgroundColor: '#00000000'`)
  * Windows OS-level Click-Through (`win.setIgnoreMouseEvents(true, { forward: true })`)
* **Native Input Injection Driver**:
  * Windows PowerShell + Inline C# P/Invoke Helper
  * Win32 `SendInput` API (`MOUSEEVENTF_MOVE`, `MOUSEEVENTF_LEFTDOWN/UP`, `MOUSEEVENTF_RIGHTDOWN/UP`, `MOUSEEVENTF_WHEEL`)
  * Hardware Subpixel Fraction Accumulator (미세 떨림 방지 및 부드러운 픽셀 누적)
  * Process Watchdog & Expiring Lease Safety Gate (프로세스 종료/응답 지연 시 자동 권한 회수)
* **Motion & Ergonomics Filtering**:
  * Pointer Ballistics (저속 미세 조작 감쇠 + 고속 스위프 가속 엔진)
  * Pre-Pinch Velocity Dampening (클릭 순간 커서 쏠림을 막는 속도 감쇠)
  * Click Jitter Lock (좌클릭 직후 10px 이내 미세 요동 잠금)
  * Cross-View Angle Compensation (-22° 회전 보정 및 2.2배 desk foreshortening 보정)

---

## 🧪 테스트 및 품질 검증

본 프로젝트는 안전한 입력 제어와 제스처 무결성을 위해 44개의 자동화 테스트 및 Windows SendInput 드라이버 드라이런 검증을 내장하고 있습니다.

```powershell
# 단위 테스트 (AirMouseController, Desktop IPC, 제스처 상태 기계 44개 전원 통과)
npm test

# Windows 네이티브 SendInput 드라이버 안전성 검증 (dry-run 모드로 실제 커서 간섭 없이 검증)
npm run test:native
```

---

## 🔒 개인정보 및 보안 원칙

* **100% 로컬 오프라인 처리**: 웹캠 영상과 손 관절 좌표는 외부 서버로 전송되지 않으며 사용자 PC 메모리 내에서만 실시간 처리 후 소멸됩니다.
* **비상 정지 보장**: `Ctrl + Alt + M` 글로벌 단축키는 언제든 즉시 시스템 제어권을 회수하며, 앱 비정상 종료 시 네이티브 드라이버가 누른 상태의 모든 마우스 버튼을 즉각 릴리즈합니다.
