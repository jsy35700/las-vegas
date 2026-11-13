# 🎰 LAS VEGAS · Midnight Velvet Lounge

보드게임 **라스베가스 (Las Vegas)** 의 웹 멀티플레이 & 오프라인 HTML 버전입니다.

## 주요 특징
- **공식 규칙 완벽 구현**: 54장 지폐 덱($10K~$90K), 카지노별 최소 $50,000 공개, **동점 상쇄 (Tie Cancellation)**, 2인용 **중립(하우스) 주사위**, 선택형 **왕주사위(Big Die 2×)**, 4라운드 진행 및 지폐 수 타이브레이커.
- **HTML 단독 실행 + 실시간 서버 멀티플레이**:
  - `public/index.html`만 브라우저로 직접 열어도(서버 없이) **싱글 AI 대전** 및 **로컬 패스 & 플레이**가 즉시 작동하며, 배포된 WebSocket URL을 입력해 온라인 서버에 붙을 수도 있습니다.
  - Node.js 서버 실행 시 **실시간 멀티플레이 방 만들기 / 코드·링크 초대 / AI 봇 합류 / 재접속 복구 / 채팅·이모트 / 턴 타이머**를 지원합니다.
- **몰입형 그래픽 & 이펙트**: 미드나잇 벨벳 카지노 라운지 테마, 3D CSS 주사위 회전/낙하 애니메이션, 주사위·지폐 비행 연출, HTML5 Canvas 파티클 & 우승 컨페티.
- **카지노 바 분위기 사운드 (Web Audio API 100% 자체 합성)**:
  - 외부 음원 파일 없이 실시간 합성되는 **Velvet Nu-Jazz** & **High-Roller Deep House** 라운지 BGM 2종 전환.
  - 주사위 컵 흔들기·펠트 바운스, 칩 배치 화음, 동점 상쇄 경고음, 지폐 정산 아르페지오 등 입체 SFX.

---

## 1. 로컬 서버 실행 (멀티플레이 포함)
```bash
npm install
npm start
```
브라우저에서 `http://localhost:3000` 접속 후 방을 만들고 **초대 링크 복사**로 다른 브라우저/기기에서 바로 함께 플레이할 수 있습니다.

## 2. HTML 단독 실행 (서버 없이)
`public/index.html` 파일을 브라우저로 직접 열면 서버 없이 **싱글 · AI 대전** 또는 **로컬 패스 & 플레이**를 즉시 즐길 수 있습니다.
배포된 서버가 있다면 메인 화면의 **"외부/배포 서버 URL 직접 연결"** 에 `wss://...` 주소를 입력해 접속할 수 있습니다.

## 3. 클라우드 서버 배포 (멀티플레이)
Node.js + 단일 포트 HTTP/WebSocket 구조를 사용하므로 무료 클라우드 호스팅에 바로 배포됩니다.

### Oracle Cloud 서버 배포 (현재 운영 중)
- 주소: **https://lasvegas.137-131-50-244.sslip.io**
- 서버 구성: `/opt/las-vegas` (Node 24 런타임 + 릴리스 폴더), systemd 서비스 `las-vegas` (127.0.0.1:3102), 같은 서버의 After Hours Caddy가 HTTPS를 처리합니다.
- 코드를 고친 뒤 다시 배포하려면 이 폴더에서 PowerShell로 실행:
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
  ```
- 서버 상태 확인: `ssh -i ~/.ssh/oracle_ig ubuntu@137.131.50.244 "systemctl status las-vegas --no-pager"`

### Render 배포 (`render.yaml` 포함)
1. 이 폴더를 GitHub 저장소에 푸시합니다.
2. [Render](https://render.com) → **New + → Blueprint** (또는 Web Service)에서 저장소를 연결합니다.
3. Build Command: `npm install`, Start Command: `npm start`, Health Check Path: `/health`.
4. 배포 완료 후 발급된 `https://xxx.onrender.com` 주소를 친구들과 공유하세요 (`wss://` 자동 연결).

### Railway / Fly.io
- `npm install` 후 `npm start` 실행 (`PORT` 환경 변수 자동 인식).

## 테스트
```bash
npm test
```
- `test/engine.test.js`: 덱 구성, 중립 주사위, 동점 상쇄, 왕주사위, 4라운드 금액 보존 시뮬레이션 검증
- `test/server.test.js`: HTTP/WebSocket 방 생성·입장·권한 검증·1라운드 실시간 진행·토큰 재접속 검증
