# Slack-Claude Bridge

Slack 메시지를 통해 Claude CLI와 상호작용할 수 있는 브릿지 애플리케이션입니다. tmux 세션을 통해 Claude CLI 프로세스를 관리하고, 터미널 출력을 실시간으로 Slack에 전달합니다.

## 주요 기능

- Slack 메시지를 Claude CLI로 전달
- tmux 기반 세션 관리 (사용자별 독립 세션)
- 실시간 터미널 출력 스트리밍
- 키보드 입력 매핑 (Enter, 화살표, Tab 등)
- 세션 복구 및 고아 세션 감지

## 요구사항

- Node.js 18+
- tmux
- Claude CLI (`claude` 명령어가 PATH에 있어야 함)
- Slack App (Socket Mode 활성화)

## 설치

```bash
# 저장소 클론
git clone <repository-url>
cd slack-claude-bridge

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 편집하여 Slack 자격증명 입력
```

## Slack App 설정 (자동 구성)

가장 쉬운 방법은 **App Manifest**를 사용하는 것입니다.

1. [Slack API Apps](https://api.slack.com/apps) 페이지로 이동합니다.
2. **Create New App** -> **From an app manifest** 선택.
3. 워크스페이스 선택 후, 아래 **YAML** 코드를 붙여넣습니다.

```yaml
display_information:
  name: Claude Bridge
  description: Connect local Claude CLI to Slack via Tmux
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: Claude Bridge
    always_online: true
  slash_commands:
    - command: /cd
      description: Change working directory
      usage_hint: /path/to/project
    - command: /reset
      description: Clear output buffer
    - command: /exit
      description: Terminate current session
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - commands
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

4. 앱 생성 후 **Install to Workspace**를 클릭하여 설치합니다.

## 토큰 및 키 확인 방법

앱 생성 후 `.env` 파일에 다음 정보를 채워넣어야 합니다.

| 변수 | 위치 (왼쪽 사이드바 메뉴) | 설명 |
|------|---------------------------|------|
| **`SLACK_SIGNING_SECRET`** | **Basic Information** > **App Credentials** | 앱의 서명 비밀키입니다. |
| **`SLACK_APP_TOKEN`** | **Basic Information** > **App-Level Tokens** | **Generate Token and Scopes** 클릭 -> 이름 입력 -> `connections:write` 권한 추가 후 생성. (`xapp-`로 시작) |
| **`SLACK_BOT_TOKEN`** | **OAuth & Permissions** > **OAuth Tokens for Your Workspace** | 앱 설치 후 생성됩니다. (`xoxb-`로 시작) |
| **`ALLOWED_USER_ID`** | Slack 앱 내 본인 프로필 클릭 > **더보기(...)** > **Copy member ID** | 보안을 위해 본인만 사용하도록 설정합니다. (선택사항) |

## 환경변수

| 변수 | 설명 | 필수 |
|------|------|------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) | O |
| `SLACK_APP_TOKEN` | App-Level Token (xapp-...) | O |
| `SLACK_SIGNING_SECRET` | Signing Secret | O |
| `ALLOWED_USER_ID` | 허용할 사용자 ID (비워두면 전체 허용) | X |
| `CLAUDE_PATH` | Claude CLI 경로 (기본값: `claude`) | X |

## 실행

```bash
npm start
```

## 사용법

### 기본 명령어

| 명령어 | 설명 |
|--------|------|
| 명령어 | 설명 | 비고 |
|--------|------|------|
| `/cd <path>` | 해당 경로에서 새 세션 시작 | `cd <path>`와 같이 일반 메시지로도 가능 |
| `/exit` | 현재 세션(Claude) 종료 | `exit`라고 입력해도 됨 |
| `/reset` | 화면 출력 초기화 | `clear`라고 입력해도 됨 |
| 일반 메시지 | Claude에게 그대로 전달됨 | |

> **Tip:** 경로는 `~/workspace` 처럼 `~` (홈 디렉토리)를 사용할 수 있습니다.

### 키 입력

| 입력 | 동작 |
|------|------|
| `.` 또는 `enter` | Enter 키 |
| `up` 또는 `k` | 위쪽 화살표 |
| `down` 또는 `j` | 아래쪽 화살표 |
| `esc` | Escape 키 |
| `ctrl-c` | Ctrl+C |
| `tab` | Tab 키 |
| `stab` 또는 `shift-tab` | Shift+Tab |

## 라이선스

MIT
