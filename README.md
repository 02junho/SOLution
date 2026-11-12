# SOLution

개인 카페 사장님의 **이번 주 매입 준비**와 **피크 시간 운영 실험**을 돕는 AI 에이전트

- ① 매입: 판매 실적 → 재료표로 필요량 계산 → 재고 차감 → 조건을 지키는 거래처별 구매안
- ② 운영: 시간대별 손님 수·인원으로 운영안(현재 · A 서로 돕기 · C 1명 추가)을 시뮬레이션해 대기시간·인건비 비교

| 영역 | 기술 |
| --- | --- |
| 화면 | React 19 + TypeScript, Vite |
| 서버 | Spring Boot 4.1 (Java 21, Gradle) — 세션·대화 기록·확정 저장 |
| AI·계산 | FastAPI (Python 3.13), LangChain/LangGraph, Claude Sonnet 5.5, PuLP 4, SimPy |
| DB | PostgreSQL 16 + pgvector, 테이블은 Flyway로 관리 |
| 실행 | Docker Compose (DB·Spring·FastAPI) |

---

## 폴더 구조

```text
SOLution/
├── frontend/                     # React + TypeScript
│   └── src/
│       ├── api/                  # 서버 호출 함수
│       ├── components/
│       │   └── common/           # 공통 카드·입력 폼·결과 화면 부품
│       ├── features/
│       │   ├── purchase/         # ① 매입 화면
│       │   └── operation/        # ② 운영 비교 화면 (대기열 애니메이션, 배치표)
│       ├── hooks/
│       ├── pages/
│       ├── types/                # API 응답 타입
│       └── utils/
│
├── backend/                      # Spring Boot
│   ├── src/main/resources/
│   │   ├── application.yml
│   │   └── db/migration/         # DB 테이블 (Flyway, V1__init_schema.sql)
│   └── src/main/java/com/solution/
│       ├── common/               # 공통 응답 형식, 예외 처리, 설정, FastAPI 호출(AiServerClient)
│       ├── store/                # 매장·기초 설정 (store)
│       ├── session/              # 세션·입력 버전·대화 기록 (work_session, work_version, session_message)
│       ├── decision/             # 사장님 확정 처리 (work_confirmation에 기록)
│       ├── purchase/             # ① 매입 API
│       │   ├── controller/
│       │   ├── service/
│       │   └── dto/
│       └── operation/            # ② 운영 API
│           ├── controller/
│           ├── service/
│           └── dto/
│
├── ai-server/                    # FastAPI
│   ├── app/
│   │   ├── main.py
│   │   ├── core/                 # 설정, 공통 응답 형식, 상태값
│   │   ├── agent/                # LangGraph 에이전트 흐름, 프롬프트
│   │   ├── rag/                  # 견적 품목 매칭, 근거 문서 검색 (rag_chunk)
│   │   ├── tools/
│   │   │   ├── quote/            # 견적 정리·필요량 계산
│   │   │   ├── purchase/         # 구매 최적화 (재고 차감 포함)
│   │   │   ├── simulation/       # 운영 시뮬레이션
│   │   │   └── labor/            # 인건비·배치표
│   │   └── schemas/              # 요청·응답 모델
│   └── tests/
│
├── data/
│   ├── public/                   # 공공데이터 파일 (서울시 추정매출 등)
│   ├── dictionary/               # 품목·단위 사전, 메뉴 재료표
│   ├── docs/                     # RAG 근거 문서 (노동 규칙, 가정표 등)
│   └── demo/                     # 시연용 합성 데이터
│
├── docs/                         # 설계 문서 (C4, ERD 등)
├── docker-compose.yml
├── .env.example
└── README.md
```

- 기능 코드는 `features/`(화면), `purchase/`·`operation/`(Spring), `tools/`(FastAPI) 아래 **기능별 폴더**에 둡니다.
- 여러 기능이 같이 쓰는 코드는 `common/`(화면·Spring), `core/`(FastAPI)에만 둡니다.
- DB는 테이블마다 쓰는 서버가 정해져 있습니다. Spring은 `store`·`work_session`·`work_version`·`work_result`·`work_confirmation`·`session_message`, FastAPI는 `execution_log`·`rag_chunk`만 씁니다.

---

## 실행 방법

### 0. 준비

| 도구 | 버전 | 비고 |
| --- | --- | --- |
| Docker Desktop | 최신 | DB(또는 전체)를 compose로 띄울 때 |
| JDK | 17 이상 | Gradle이 JDK 21을 자동으로 내려받습니다 |
| Python | 3.13 | |
| Node.js | 22 이상 | |

```bash
cp .env.example .env
```

`.env`를 열어 **`POSTGRES_PASSWORD`(아무 값)** 와 `ANTHROPIC_API_KEY`를 채웁니다. 비워 두면 DB가 뜨지 않습니다.

### 1. 한 번에 띄우기 (DB + FastAPI + Spring)

```bash
docker compose up --build
```

화면은 아래 4번처럼 따로 띄웁니다.

### 2. 개발할 때 (DB만 Docker, 서버는 직접 실행)

```bash
docker compose up -d db
```

**Spring** (`backend/`, 8080) — 루트의 `.env`를 자동으로 읽고, 처음 뜰 때 Flyway가 테이블을 만듭니다.

```bash
cd backend && ./gradlew bootRun
```

**FastAPI** (`ai-server/`, 8000)

```bash
cd ai-server
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

### 3. 테스트

```bash
cd backend && ./gradlew test
```

```bash
cd ai-server && pytest
```

### 4. 화면 (`frontend/`, 5173)

```bash
cd frontend && npm install && npm run dev
```

http://localhost:5173 에 `Spring / Spring → DB / Spring → FastAPI / FastAPI → DB`가 모두 `ok`로 나오면 연결이 끝난 것입니다. `/api` 요청은 Vite가 Spring(8080)으로 넘겨 줍니다.

---

## 서버 간 호출 규칙

```text
화면 ──/api/v1/...──▶ Spring ──/tools/{기능}·/agent/...──▶ FastAPI
                        │                                    │
                        ▼                                    ▼
          store·work_session·work_version·         execution_log·rag_chunk
          work_result·work_confirmation·
          session_message 저장
```

- **화면은 Spring만 부릅니다.** FastAPI는 Spring이 `AiServerClient`로 부릅니다. 예시는 `common/system/SystemController`에 있습니다.
- **주소**: Spring은 `/api/v1/...`, FastAPI 도구는 `/tools/quote`·`/tools/purchase`·`/tools/simulation`·`/tools/labor`, 에이전트는 `/agent/interpret`(분류·입력 추출·검사·질문)와 `/agent/explain`(결과 설명). 둘 사이에 사장님 입력 확인과 도구 계산이 들어갑니다.
- **응답 모양**은 모든 서버가 같습니다. Spring은 `ApiResponse`, FastAPI는 `app/core/response.py`, 화면은 `src/types/api.ts`를 씁니다.

  ```json
  { "status": "ok", "data": { }, "message": null }
  ```

| status | HTTP | 언제 |
| --- | --- | --- |
| `ok` | 200 | 정상 |
| `needs_input` | 200 | 정보 부족. 사장님께 물어볼 내용을 `message`·`data`에 담음 |
| `infeasible` | 200 | 조건을 만족하는 답이 없음. 지원 범위 밖 요청(예: 직원 5명)도 여기에 넣고 세부 상태 `UNSUPPORTED`, `message`에 가장 가까운 후보 제안 |
| `error` | 400 / 404 / 500 / 502 | 잘못된 요청, 없는 주소, 서버 오류, FastAPI 연결 실패 |

- 기능별 세부 상태(`OPTIMAL` 등)는 `status`를 늘리지 않고 `data` 안에 넣습니다.
- **JSON 이름은 snake_case**(`item_id`, `price_krw`)입니다. Spring은 Java 필드를 camelCase(`itemId`)로 쓰면 주고받을 때 자동으로 바뀌고, FastAPI·화면은 snake_case 그대로 씁니다.
- **요청 키**: Spring이 `X-Request-Key` 헤더로 넘기고, FastAPI는 `get_request_key`로 받아 `execution_log.request_key`에 씁니다. 같은 요청을 다시 보낼 때는 같은 키를 씁니다.
- **기다리는 시간**: Spring → FastAPI 연결 3초, 응답 120초(`application.yml`의 `ai-server.*`).
- **DB 테이블을 바꿀 때**: `V1__init_schema.sql`은 고치지 말고 `backend/src/main/resources/db/migration/V2__설명.sql`을 새로 추가합니다.
- **RAG 벡터**: `rag_chunk.embedding`은 `vector(1024)`(KURE-v1)이고, 코사인 거리 HNSW 인덱스가 있습니다.
- **LLM 모델**: Claude Sonnet 5.5(`claude-sonnet-5-5`). 코드에 모델 이름을 직접 쓰지 말고 `get_settings().anthropic_model`(`.env`의 `ANTHROPIC_MODEL`)을 씁니다. 이 모델은 다음을 넣으면 400 오류가 납니다.
  - 도구 강제 호출(`tool_choice`의 `any`·`tool`): 입력 JSON을 받을 때는 structured outputs(JSON 스키마) 방식이나 `tool_choice` `auto` + `strict` 도구를 씁니다.
  - `temperature`·`top_p` 값 지정, thinking 끄기(`disabled`), 답 앞부분 미리 채우기(prefill)
  - 안전 분류기가 거절하면 `stop_reason`이 `refusal`로 옵니다. LLM 실패와 같이 "폼으로 입력" 안내로 처리합니다.

---

## ⚠️ 개발 주의 사항

### 브랜치·PR

| 브랜치 | 용도 | 규칙 |
| --- | --- | --- |
| `main` | 시연·발표용 | 직접 커밋 금지. `dev`에서 동작 확인된 것만 병합 |
| `dev` | 통합 개발 | 모든 기능 브랜치가 여기로 PR |
| `feat/기능명` | 기능 작업 | 이슈 번호 포함 (예: `feat/12-labor-cost`) |

- PR은 리뷰 1명 이상 승인 후 병합합니다.
- PR을 올리면 CI(`.github/workflows/ci.yml`)가 Spring·FastAPI 테스트, 화면 린트·빌드, docker compose 연결 확인을 자동으로 돌립니다. 모두 통과해야 병합합니다.
- 다른 사람 기능 폴더를 고쳤다면 그 기능 담당에게 리뷰를 요청합니다.

### 커밋 메시지

```text
타입: 무엇을 했는지 (한 줄)

feat      기능 추가
fix       버그 수정
refactor  동작 변화 없는 코드 정리
docs      문서
test      테스트
chore     설정·빌드

예) feat: 인건비 계산에 주휴수당 반영
```

### 환경 변수·보안

- `.env`는 절대 커밋하지 않습니다. 필요한 키 형식은 `.env.example`에만 적습니다.
- API 키를 코드나 채팅에 붙여넣지 않습니다.
- 실제 견적서·대화 캡처는 가게 이름, 연락처 등 식별 정보를 지운 뒤에만 `data/`에 넣습니다.

### 자료·규칙 파일

자료와 규칙은 **누구나 읽고 가져다 쓸 수 있지만**, 아래는 직접 고치지 않습니다.

| 대상 | 위치 |
| --- | --- |
| 다른 사람이 채운 자료 | `data/demo/`, `data/dictionary/` (파일별로 잘 아는 사람은 `data/README.md`) |
| 공공데이터 원본 | `data/public/`. 가공이 필요하면 원본은 두고 새 파일로 만듭니다 |
| 규칙 | `data/docs/`의 노동 규칙·가정 문서, 이 README의 개발 주의 사항, Code Convention |

- 고칠 일이 생기면 **무엇을, 왜 바꾸는지 팀에 먼저 공유**합니다. 바꾸는 것은 그 자료를 잘 아는 사람이 하거나, 그 사람의 리뷰를 받은 PR로 합니다.
- CSV 첫 줄의 칸 이름과 JSON 키는 코드가 읽는 이름이라, 공유 없이 바꾸지 않습니다.
- 품목 ID·단위처럼 여러 파일이 같이 쓰는 값이 바뀌면 영향을 받는 담당자에게 같이 알립니다.

### 패키지 추가

- Python 패키지는 `ai-server/requirements.txt`에 **버전을 고정해서**(`이름==버전`) 적습니다. 테스트에만 쓰는 것은 `requirements-dev.txt`에 적습니다.
- PuLP는 4.2.0입니다. 3.x로 만든 PoC 코드와 쓰는 법이 조금 다릅니다(변수는 `prob.add_variable(...)`, `LpStatus` 없음). 3.x는 Apple Silicon Mac에서 기본 풀이기가 돌지 않습니다.

### 계산 규칙 (연결할 때 어긋나기 쉬운 것)

- **재고 차감은 구매 최적화에서 한 번만** 합니다. 견적 정리·필요량 계산은 총 필요량만 넘깁니다.
- 단위는 g·ml·개, 금액은 원으로 통일합니다. 품목 ID는 품목 사전 기준입니다.
- 부가세 포함 여부를 모르면 계산은 진행하고 결과에 "부가세 미확인"을 표시합니다.
- 숫자 계산은 코드가 하고, LLM은 사장님 말을 숫자·조건으로 바꾸는 역할만 합니다.
- 운영 변경안은 정해 둔 후보(현재·A·C)에서 고르고, 후보 밖 요청은 가장 가까운 후보로 제안하거나 "범위 밖"으로 안내합니다.
- 인건비 시급은 기본이 그 해 최저시급(2026년 10,320원)입니다. 매장에서 따로 정한 시급이 있으면 사장님이 입력해서 바꾸고, 최저시급보다 낮으면 막습니다.

### 화면 표시

- 시뮬레이션 결과에는 항상 **"모의 조건"** 을 표시합니다.
- 신한카드·마이샵 파트너의 로고와 화면을 복제하지 않습니다.
