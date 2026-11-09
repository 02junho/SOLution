# SOLution

개인 카페 사장님의 **이번 주 매입 준비**와 **피크 시간 운영 실험**을 돕는 AI 에이전트

- ① 매입: 판매 실적 → 재료표로 필요량 계산 → 재고 차감 → 조건을 지키는 거래처별 구매안
- ② 운영: 시간대별 손님 수·인원으로 운영안(현재 · A 서로 돕기 · C 1명 추가)을 시뮬레이션해 대기시간·인건비 비교

| 영역 | 기술 |
| --- | --- |
| 화면 | React + TypeScript |
| 서버 | Spring Boot (세션·대화 기록·확정 저장) |
| AI·계산 | FastAPI, LangChain/LangGraph, PuLP, SimPy |
| DB | PostgreSQL + pgvector |
| 실행 | Docker Compose |

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
│   └── src/main/java/com/solution/
│       ├── common/               # 공통 응답 형식, 예외 처리, 설정
│       ├── session/              # 세션·대화 기록
│       ├── decision/             # 사장님 확정 저장
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
│   │   ├── rag/                  # 견적 품목 매칭, 근거 문서 검색
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

---

## ⚠️ 개발 주의 사항

### 브랜치·PR

| 브랜치 | 용도 | 규칙 |
| --- | --- | --- |
| `main` | 시연·발표용 | 직접 커밋 금지. `dev`에서 동작 확인된 것만 병합 |
| `dev` | 통합 개발 | 모든 기능 브랜치가 여기로 PR |
| `feat/기능명` | 기능 작업 | 이슈 번호 포함 (예: `feat/12-labor-cost`) |

- PR은 리뷰 1명 이상 승인 후 병합합니다.
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

### 계산 규칙 (연결할 때 어긋나기 쉬운 것)

- **재고 차감은 구매 최적화에서 한 번만** 합니다. 견적 정리·필요량 계산은 총 필요량만 넘깁니다.
- 단위는 g·ml·개, 금액은 원으로 통일합니다. 품목 ID는 품목 사전 기준입니다.
- 부가세 포함 여부를 모르면 계산은 진행하고 결과에 "부가세 미확인"을 표시합니다.
- 숫자 계산은 코드가 하고, LLM은 사장님 말을 숫자·조건으로 바꾸는 역할만 합니다.
- 운영 변경안은 정해 둔 후보(현재·A·C)에서 고르고, 후보 밖 요청은 가장 가까운 후보로 제안하거나 "범위 밖"으로 안내합니다.
- 인건비는 사장님이 입력한 실제 시급으로 계산하고, 최저시급보다 낮으면 막습니다.

### 화면 표시

- 시뮬레이션 결과에는 항상 **"모의 조건"** 을 표시합니다.
- 신한카드·마이샵 파트너의 로고와 화면을 복제하지 않습니다.
