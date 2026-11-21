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
| 실행 | Docker Compose (DB·Spring·FastAPI), 배포는 화면 nginx를 더한 `docker-compose.prod.yml` |

---

## 폴더 구조

```text
SOLution/
├── frontend/                     # React + TypeScript
│   ├── Dockerfile, nginx.conf    # 배포용 화면 이미지 (빌드 결과 + /api를 Spring으로)
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
├── docker-compose.yml            # 로컬·CI (DB·FastAPI·Spring)
├── docker-compose.prod.yml       # 배포 (GHCR 이미지 + 화면 nginx, 80번만 공개)
├── .env.example
└── README.md
```

- 기능 코드는 `features/`(화면), `purchase/`·`operation/`(Spring), `tools/`(FastAPI) 아래 **기능별 폴더**에 둡니다.
- 여러 기능이 같이 쓰는 코드는 `common/`(화면·Spring), `core/`(FastAPI)에만 둡니다.
- DB는 테이블마다 쓰는 서버가 정해져 있습니다. Spring은 `store`·`work_session`·`work_version`·`work_result`·`work_confirmation`·`session_message`·`calculation_run`·`retired_confirmation_key`·`quote_demo_resource`, FastAPI는 `execution_log`·`rag_chunk`를 씁니다. 예외로 최종 확정 기록은 확정을 처리하는 Spring이 `execution_log`에 남깁니다(`log_type='tool'`, `name='confirm'`, 가드레일 명세 GR-19). 이 기록은 확정과 다른 트랜잭션에서 최선 시도로 남기므로, 기록이 실패해도 확정은 그대로 성공합니다. 확정의 원본은 `work_confirmation`이고, `execution_log`의 확정 기록은 빠질 수 있는 참고용입니다.

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

### 업무 대화·계획 삭제

- **이어하기 → 대화 기록 삭제**: 해당 업무를 이어하기에서 다시 열 수 없습니다. 저장한 계획은 별도로 남으며 **저장한 계획 → 계획 삭제**에서 지울 수 있습니다.
- **저장한 계획 → 계획 삭제**: 목록 카드와 계획 상세 창에서 삭제할 수 있습니다. 선택한 계획의 저장 기록만 삭제하며 업무 대화·입력·계산 결과는 유지합니다. 현재 조건의 계획을 삭제했다면 계산 결과에서 다시 선택해 저장할 수 있습니다.
- API: `DELETE /api/v1/work-sessions/{sessionId}`, `DELETE /api/v1/work-confirmations/{confirmationId}`. 본인 소유 데이터만 삭제할 수 있습니다. 활성 계산 중에는 이어하기의 업무 삭제를 차단합니다.

계산 요청은 실행별 DB 임대 기록으로 추적합니다. 10초마다 유효 시간을 2분 연장하고, 정상 종료 시 해당 실행만 정리합니다. 프로세스 종료·정리 실패 시 갱신이 중단되며, 만료 후 다음 업무 삭제 또는 계산 시작에서 해당 기록과 남은 `running` 단계를 복구합니다. 다른 활성 실행은 유지하고, 만료된 요청의 결과 저장은 거부합니다. AI 호출 중에는 DB 트랜잭션·세션 잠금을 유지하지 않습니다. 계획 삭제 전 저장 키는 서버에 별도로 보관해 늦은 재시도를 거부하며, 화면은 다음 저장에 새 키를 사용합니다.

### 3. 테스트

```bash
cd backend && ./gradlew test
```

이름이 `…IntegrationTest`인 테스트는 임시 PostgreSQL을 Docker로 띄워 실제 DB로 확인합니다(Testcontainers). Docker Desktop이 켜져 있어야 돌고, `@Testcontainers(disabledWithoutDocker = true)`를 붙이면 Docker가 없을 때 실패 대신 건너뜁니다. CI에서는 항상 돕니다.

```bash
cd ai-server && pytest
```

```bash
cd frontend && npm test
```

### 4. 화면 (`frontend/`, 5173)

```bash
cd frontend && npm install && npm run dev
```

http://localhost:5173 에 `Spring / Spring → DB / Spring → FastAPI / FastAPI → DB`가 모두 `ok`로 나오면 연결이 끝난 것입니다. `/api` 요청은 Vite가 Spring(8080)으로 넘겨 줍니다. 5173이 이미 쓰이고 있어 Vite가 5174 등 다른 번호로 뜨거나 `127.0.0.1`로 열어도 그대로 쓸 수 있습니다.

### 5. 시연용 기본 데이터 (`DEMO_SEED=true`)

`.env`에서 `DEMO_SEED=true`로 바꾸면 Spring이 뜰 때 시연 데이터를 넣습니다(`.env.example`의 기본값은 `false`. 실제 매장 데이터를 쓰는 배포에서는 끄고, 시연용 서버에서는 켭니다). 이미 있으면 건너뜁니다. CI는 compose 단계에서 켜고 확인합니다. 내용은 `backend/src/main/resources/db/demo/demo_seed.sql`입니다.

| 데이터 | 값 | 계산 실행 결과 |
| --- | --- | --- |
| 매장 | `store_id` 1, 을지로입구 데모 카페, `owner_key` demo-owner | |
| 구매 업무 1001 (입력 버전 100101) | API 명세 예시 그대로 | `ok` · 안 1 120,400원 · 안 2 138,000원 |
| 구매 업무 1002 (입력 버전 100201) | 예산만 100,000원 | `infeasible` · 예산 부족 |
| 구매 업무 1003 (입력 버전 100301) | 우유 재고 빈칸 | `needs_input` · 우유 재고 질문 |
| 구매 업무 1004 (입력 버전 100401) | `data/demo` 시연 자료 (품목 5 · 거래처 4) | `ok` · 안 1 125,500원 · 안 2 127,500원 · 기준선 119,500원(배송 3회 · 최소 주문 미달로 주문 불가) |
| 구매 업무 1005 (입력 버전 100501) | `data/demo/expanded` 시연 자료 (품목 5 · 거래처 12: 원두·우유·포장재 전문점 3곳씩 + 종합 3곳) | `ok` · 안 1 113,280원 · 안 2 127,500원 · 기준선 166,090원(배송 4회 · 최소 주문 미달 · 보관 한도 초과로 주문 불가). 배송 한도를 3회로 바꾸면 안 1 101,090원 |

다섯 업무 모두 입력 확인이 끝난 상태라, http://localhost:8080/docs 에서 바로 부를 수 있습니다.

```bash
curl -X POST localhost:8080/api/v1/purchase/sessions/1001/results -H 'Content-Type: application/json' -d '{"input_version_id": 100101}'
```

응답의 `result_id`로 `GET /api/v1/purchase/results/{result_id}`를 부르면 상세(거래처별 목록·주문 문구)를 봅니다. CI의 compose 단계도 이 다섯 건으로 끝까지 확인합니다. 이미 시연 데이터를 넣은 DB라면 `docker compose up -d --build backend`로 다시 띄우면 없는 업무(1004·1005)만 추가됩니다. 업무 시작(`POST /api/v1/work-sessions`)에는 `store_id` 1을 쓰면 됩니다.

### 6. 연결을 하나씩 확인하기

`docker compose up -d --build`로 띄운 뒤 저장소 루트에서 실행합니다. 번호를 주면 그 단계만 돕니다. 비밀번호·키 값은 출력하지 않습니다.

```bash
./scripts/local-check.sh
```

```bash
./scripts/local-check.sh 4
```

| 단계 | 확인하는 것 |
| --- | --- |
| 0 | `.env` 필수 칸, `DEMO_SEED=true` |
| 1 | 컨테이너 세 개(db · ai-server · backend) |
| 2 | DB 혼자, Flyway 테이블 11개 |
| 3 | FastAPI 혼자, FastAPI → DB (`/health`) |
| 4 | Spring 혼자, Spring → DB, Spring → FastAPI (`/api/v1/system/health`) |
| 5 | API 문서(`/docs`) |
| 6 | 시연 데이터 (매장 1, 구매 업무 1001~1005) |
| 7 | 구매 정상: 계산 → 저장 → 상세 재조회, 주문 문구 |
| 8 | 구매 나머지: 예산 부족(infeasible), 재고 빈칸(needs_input), 거래처 4곳(ok), 거래처 12곳(ok) |
| 9 | 같은 요청 키로 두 번 보내면 결과 1건 |
| 10 | FastAPI 실행 기록(`execution_log`) |

실패한 단계는 무엇을 볼지(`docker compose logs backend` 등)를 같이 알려 줍니다. 끝낼 때는 `docker compose down`(데이터 유지) 또는 `docker compose down -v`(로컬 DB까지 삭제).

### 7. 배포용 구성 (`docker-compose.prod.yml`)

서버 한 대에 DB·FastAPI·Spring·화면(nginx) 네 개를 띄웁니다. 서버에서는 빌드하지 않고 GHCR(`ghcr.io/02junho/solution-*`) 이미지를 받아 씁니다. 밖에는 80번만 열리고, 화면과 `/api`가 같은 주소라 개발 때 Vite가 하던 `/api` 전달은 nginx(`frontend/nginx.conf`)가 합니다.

서버 `.env`는 `.env.example`을 복사해 채우고, 아래 값을 배포에 맞게 바꿉니다.

| 항목 | 값 |
| --- | --- |
| `FRONTEND_ORIGIN` | `http://서버주소` (브라우저로 여는 주소) |
| `DEMO_SEED` | 시연 서버는 `true` |
| `SWAGGER_ENABLED` | `false` (API 문서 닫기) |
| `POSTGRES_PASSWORD` | 로컬과 다른 긴 값 |

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

**이미지 게시**: GHCR에 이미지를 올리는 GitHub Actions 작업은 아직 없습니다. 서버를 만든 뒤 `ci.yml`에 "dev 병합 → 이미지 세 개 빌드·게시 → 서버 갱신" 작업으로 추가합니다(당분간 dev 기준, 마지막에 main 기준). 그 전에 서버에서 써야 하면 로컬에서 직접 올립니다. 토큰은 GitHub 설정의 Personal access token(classic)에서 `write:packages`로 만들고, 처음 올린 패키지는 비공개라 GitHub → Packages에서 세 개 모두 Public으로 바꿔야 서버가 로그인 없이 받습니다.

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u 깃허브아이디 --password-stdin
for app in backend ai-server frontend; do
  # 빌드나 push가 하나라도 실패하면 멈춘다 (예전 :latest가 대신 올라가지 않게)
  docker build --platform linux/amd64 -t ghcr.io/02junho/solution-${app}:latest ./${app} \
    && docker push ghcr.io/02junho/solution-${app}:latest \
    || { echo "${app} 실패: 여기서 멈춤"; break; }
done
```

`http://서버주소/api/v1/system/health`에서 `database`·`ai_server`가 모두 `ok`면 끝입니다. 로컬에서 같은 구성을 확인하려면 파일 맨 위 주석대로 이미지 세 개를 먼저 빌드한 뒤 띄우고 http://localhost 로 엽니다. 시연 데이터를 처음 상태로 돌리려면 `docker compose -f docker-compose.prod.yml down -v` 뒤 다시 `up -d` 합니다.

---

## 서버 간 호출 규칙

```text
화면 ──/api/v1/...──▶ Spring ──/tools/{기능}·/agent/...──▶ FastAPI
                        │                                    │
                        ▼                                    ▼
          store·work_session·work_version·         execution_log·rag_chunk
          work_result·work_confirmation·
          session_message 저장
          (+ 확정 기록만 execution_log)
```

- **화면은 Spring만 부릅니다.** FastAPI는 Spring이 `AiServerClient`로 부릅니다. 예시는 `common/system/SystemController`에 있습니다.
- **주소**: Spring은 `/api/v1/...`, FastAPI 도구는 `/tools/quote`·`/tools/purchase`·`/tools/simulation`·`/tools/labor` 4개, 에이전트는 `/agent/interpret`(분류·입력 추출·검사·질문)와 `/agent/explain`(결과 설명). 둘 사이에 사장님 입력 확인과 도구 계산이 들어갑니다.
  - 한 도구 안에서 하는 일이 여러 개면 `/tools/{도구}/{동작}`으로 나눕니다 (예: `/tools/labor/cost`·`/tools/labor/schedule`, `/tools/simulation/compare`). 동작이 하나면 `/tools/purchase`처럼 그대로 둡니다. 세부 주소는 Spring 안에서만 쓰므로 화면은 바뀌지 않습니다.
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
- 400·404의 사유는 `data.detail_code`로 나눕니다(예: `INPUT_NOT_CONFIRMED`, `STALE_VERSION`, `SESSION_NOT_FOUND`). Spring은 `ApiException.badRequest(코드, 문구)`·`notFound(코드, 문구)`로 던지면 공통 처리기가 `data: {"detail_code": ...}`로 내보냅니다. 코드 없이 던지면 `data`는 `null`입니다.
- **기능마다 같은 이름을 쓰는 칸** (화면·확정 API가 기능 구분 없이 같은 방식으로 읽습니다)
  - 빠진 값(`needs_input`): `data.missing_fields[]`의 기본 칸은 `{path, label, unit}`. `path`는 요청 JSON 안의 위치, `label`은 사장님께 보여 줄 이름, `unit`은 단위(없으면 `null`). 왜 필요한지는 `message`에 씁니다.
  - 경고: `warnings[]`의 기본 칸은 `{warning_id, message, requires_ack}`. 기능에 따라 칸을 더 붙여도 됩니다(예: 구매의 `choice_keys`). 확정할 때 화면은 확인한 `warning_id`만 보냅니다.
    - `requires_ack`는 꼭 `true`/`false`로 넣습니다. `true`(필수)는 고른 안에 걸려 있으면 확인해야 확정되고, `false`(참고)는 화면에 보여 주기만 합니다. 지금 필수는 `VAT_UNKNOWN`·`SIMULATED_CONDITIONS`, 참고는 `END_STOCK_OVER_LIMIT`입니다.
    - `warning_id`는 한 결과 안에서 한 번만 씁니다. 여러 안에 걸리는 경고는 따로 여러 번 넣지 말고 하나의 경고에 `choice_keys`로 묶습니다. 같은 `warning_id`가 두 번 있으면 덜 끝난 결과로 보고 확정이 막힙니다(`RESULT_NOT_READY`).
    - 운영(`operation`) 결과는 고른 안에 `SIMULATED_CONDITIONS`(`requires_ack: true`)가 있어야 확정됩니다. 이 경고가 없으면 확인할 경고가 없어도 `RESULT_NOT_READY`입니다 (가드레일 명세 GR-24).
    - Spring에 경고 허용 목록은 없습니다. 확정 API는 저장된 결과에 있는 경고로 검사하므로, 새 경고는 `requires_ack`만 정하면 됩니다 (가드레일 명세 G-D4).
  - 고를 수 있는 안: `choice_key` (매입 `purchase_1`·`purchase_2`, 운영 `CURRENT`·`ALT_A`·`ALT_C`). 확정 때는 `selected_choice_key`로 저장됩니다.
  - 운영 결과의 안 목록은 `summary.choices`이고, `summary.complete`(꼭 `true`/`false`)는 30회 완주·집계와 세 안의 배치표·비용 연결이 다 끝났을 때만 `true`입니다. 화면은 `true`일 때만 확정 버튼을 켭니다. simulation이 `complete: false`를 주면 Spring은 저장하지 않고 `400 RESULT_NOT_READY`를 돌려줍니다.
- **JSON 이름은 snake_case**(`item_id`, `price_krw`)입니다. Spring은 Java 필드를 camelCase(`itemId`)로 쓰면 주고받을 때 자동으로 바뀌고, FastAPI·화면은 snake_case 그대로 씁니다.
- **요청 키**: Spring이 `X-Request-Key` 헤더로 넘기고, FastAPI는 `get_request_key`로 받아 `execution_log.request_key`에 씁니다. 같은 요청을 다시 보낼 때는 같은 키를 씁니다.
  - 화면 → Spring 헤더는 API마다 다릅니다. 구매 계산 실행은 `X-Request-Key`(없으면 Spring이 만듦), 운영 계산 실행과 확정은 `Idempotency-Key`(필수, 1~100자)입니다. 운영은 이 키에 단계 이름을 붙여(`키:simulation`·`키:schedule`·`키:cost`) FastAPI에 넘깁니다. 헤더 이름을 하나로 맞출지는 남은 결정입니다.
  - 운영 계산 실행에 같은 키로 다른 입력 버전을 보내면 `400 IDEMPOTENCY_KEY_REUSED`입니다(확정 API도 같은 코드).
  - `work_result.request_key`에는 UQ가 없습니다(ERD). `work_result`에 쓰는 API(구매·운영 계산 실행)는 저장하는 트랜잭션 안에서 `RequestKeyLock.lock(기능, 입력버전, 요청키)`를 먼저 걸고, 같은 결과가 이미 있는지 다시 확인한 뒤 없을 때만 저장합니다. 확정(`work_confirmation`)은 `confirm_request_key` UQ가 있어 잠금이 필요 없습니다.
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
