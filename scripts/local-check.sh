#!/usr/bin/env bash
# 로컬 연결 확인. 저장소 루트에서 docker compose up -d --build 로 띄운 뒤 실행합니다.
#
#   ./scripts/local-check.sh        모든 단계를 차례로
#   ./scripts/local-check.sh 4      4단계만
#   ./scripts/local-check.sh 7 10   7단계와 10단계만
#
# 값(비밀번호·키)은 출력하지 않습니다. 필요한 도구: docker, curl, jq

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DOCKER=$(command -v docker || echo /Applications/Docker.app/Contents/Resources/bin/docker)
PASS=0
FAIL=0

if [ ! -f .env ]; then
  echo "저장소 루트에 .env가 없습니다. cp .env.example .env 후 값을 채워 주세요."
  exit 1
fi
# .env를 bash로 실행하지 않고 필요한 칸만 글자로 읽는다. Compose의 .env 문법은 bash와 달라서,
# 실행하면 괄호 같은 문자가 든 값에서 오류가 나고 오류 메시지에 값이 찍힐 수 있다.
env_get() {
  local v
  v=$(grep -E "^[[:space:]]*$1[[:space:]]*=" .env | tail -1 | cut -d= -f2-)
  v="${v#"${v%%[![:space:]]*}"}"   # 앞 공백
  v="${v%"${v##*[![:space:]]}"}"   # 뒤 공백
  if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
  printf '%s' "$v"
}
POSTGRES_DB=$(env_get POSTGRES_DB)
POSTGRES_USER=$(env_get POSTGRES_USER)
POSTGRES_PASSWORD=$(env_get POSTGRES_PASSWORD)
ANTHROPIC_API_KEY=$(env_get ANTHROPIC_API_KEY)
DEMO_SEED=$(env_get DEMO_SEED)
BACKEND_PORT=$(env_get BACKEND_PORT)
AI_SERVER_PORT=$(env_get AI_SERVER_PORT)
SPRING="http://localhost:${BACKEND_PORT:-8080}"
FASTAPI="http://localhost:${AI_SERVER_PORT:-8000}"

ok() { echo "  통과: $1"; PASS=$((PASS + 1)); }
no() { echo "  실패: $1"; [ -n "${2:-}" ] && echo "  확인: $2"; FAIL=$((FAIL + 1)); }
title() { echo; echo "[$1] $2"; }
psql_q() { "$DOCKER" compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1" 2>/dev/null; }
run_purchase() {  # 업무 번호, 입력 버전 번호, (요청 키)
  local key_header=()
  [ -n "${3:-}" ] && key_header=(-H "X-Request-Key: $3")
  curl -sS -X POST "$SPRING/api/v1/purchase/sessions/$1/results" -H 'Content-Type: application/json' \
    ${key_header[@]+"${key_header[@]}"} -d "{\"input_version_id\": $2}"
}

step0() {
  title 0 ".env 준비 (값은 출력하지 않음)"
  local missing=()
  for k in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD; do
    [ -z "${!k:-}" ] && missing+=("$k")
  done
  if [ ${#missing[@]} -eq 0 ]; then ok "DB 접속 칸이 모두 채워져 있음"; else no "비어 있는 칸: ${missing[*]}" ".env를 채운 뒤 다시 띄우세요"; fi
  [ -n "${ANTHROPIC_API_KEY:-}" ] && ok "ANTHROPIC_API_KEY 있음" || echo "  참고: ANTHROPIC_API_KEY가 비어 있음 (구매 계산에는 필요 없음, 에이전트에 필요)"
  [ "${DEMO_SEED:-}" = "true" ] && ok "DEMO_SEED=true (시연 데이터 넣음)" \
    || no "DEMO_SEED가 true가 아님" ".env에 DEMO_SEED=true를 추가하고 docker compose up -d --build backend"
}

step1() {
  title 1 "컨테이너 세 개가 떠 있는지 (db · ai-server · backend)"
  local running
  running=$("$DOCKER" compose ps --status running --services 2>/dev/null | sort | tr '\n' ' ')
  for s in db ai-server backend; do
    if [[ " $running " == *" $s "* ]]; then ok "$s 실행 중"; else no "$s가 떠 있지 않음" "docker compose up -d --build, 로그는 docker compose logs $s"; fi
  done
}

step2() {
  title 2 "DB 혼자 (PostgreSQL 응답 · Flyway가 만든 테이블 8개)"
  if "$DOCKER" compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then ok "DB가 접속을 받음"; else no "DB가 응답하지 않음" "docker compose logs db"; return; fi
  local n
  n=$(psql_q "select count(*) from information_schema.tables where table_schema = 'public' and table_name <> 'flyway_schema_history'")
  [ "$n" = "8" ] && ok "테이블 8개" || no "테이블 ${n:-0}개 (8개여야 함)" "Spring이 뜰 때 Flyway가 만듭니다. docker compose logs backend"
}

step3() {
  title 3 "FastAPI 혼자 (FastAPI → DB)  GET $FASTAPI/health"
  local body
  body=$(curl -sS "$FASTAPI/health" 2>/dev/null)
  echo "$body" | jq -e '.status == "ok"' >/dev/null 2>&1 && ok "FastAPI 응답 ok" || { no "FastAPI 응답 없음: ${body:-없음}" "docker compose logs ai-server"; return; }
  echo "$body" | jq -e '.data.database == "ok"' >/dev/null && ok "FastAPI → DB ok" || no "FastAPI → DB: $(echo "$body" | jq -c .data.database)" ".env의 POSTGRES_* 값과 DB 비밀번호가 맞는지"
}

step4() {
  title 4 "Spring 혼자 · Spring → DB · Spring → FastAPI  GET $SPRING/api/v1/system/health"
  local body
  body=$(curl -sS "$SPRING/api/v1/system/health" 2>/dev/null)
  echo "$body" | jq -e '.data.backend == "ok"' >/dev/null 2>&1 && ok "Spring 응답 ok" || { no "Spring 응답 없음: ${body:-없음}" "docker compose logs backend (처음엔 1분쯤 걸림)"; return; }
  echo "$body" | jq -e '.data.database == "ok"' >/dev/null && ok "Spring → DB ok" || no "Spring → DB: $(echo "$body" | jq -c .data.database)"
  echo "$body" | jq -e '.data.ai_server.ai_server == "ok"' >/dev/null && ok "Spring → FastAPI ok" || no "Spring → FastAPI: $(echo "$body" | jq -c .data.ai_server)"
}

step5() {
  title 5 "API 문서 (Swagger)  $SPRING/docs"
  curl -sS "$SPRING/v3/api-docs" 2>/dev/null | jq -e '.paths | has("/api/v1/purchase/sessions/{sessionId}/results")' >/dev/null 2>&1 \
    && ok "구매안 계산 실행 주소가 문서에 있음. 브라우저에서 $SPRING/docs" \
    || no "API 문서를 못 읽음" "SWAGGER_ENABLED가 false인지 확인"
}

step6() {
  title 6 "시연 데이터 (매장 1 · 입력 확인된 구매 업무 1001~1005)"
  [ "$(psql_q "select owner_key from store where store_id = 1")" = "demo-owner" ] && ok "매장 1 (demo-owner)" \
    || { no "매장 1이 없음" ".env에 DEMO_SEED=true 추가 후 docker compose up -d backend"; return; }
  local s
  s=$(psql_q "select string_agg(s.session_id::text, ',' order by s.session_id) from work_session s join work_version v on v.session_id = s.session_id and v.version_no = s.current_version where s.session_id in (1001, 1002, 1003, 1004, 1005) and v.input_confirmed_at is not null")
  [ "$s" = "1001,1002,1003,1004,1005" ] && ok "구매 업무 1001~1005, 모두 입력 확인됨" \
    || no "구매 업무: ${s:-없음}" "1004·1005가 없으면 docker compose up -d --build backend (seed는 없는 것만 추가)"
}

step7() {
  title 7 "구매 정상 (업무 1001) 화면 주소 → Spring → FastAPI 계산 → DB 저장 → 다시 조회"
  local body id detail
  body=$(run_purchase 1001 100101)
  if echo "$body" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    echo "$body" | jq -r '(.data.summary.choices[1] | if .total_krw then "\(.total_krw)원" elif .same_as then "안 1과 같음" else "없음" end) as $p2
      | "  안 1 \(.data.summary.choices[0].total_krw)원 · 안 2 \($p2) · 기준선 \(.data.summary.baseline.total_krw)원 · result_id \(.data.result_id)"'
    echo "$body" | jq -e '.data.summary.choices[0].total_krw == 120400' >/dev/null && ok "안 1 120,400원 (명세 예시 정답)" || no "안 1 금액이 120,400원이 아님"
  else
    no "응답: $(echo "$body" | jq -c . 2>/dev/null || echo "$body")" "4단계부터 확인"; return
  fi
  id=$(echo "$body" | jq -r .data.result_id)
  detail=$(curl -sS "$SPRING/api/v1/purchase/results/$id")
  if echo "$detail" | jq -e '.status == "ok" and (.data.detail.choices[0].order_messages | length) > 0' >/dev/null 2>&1; then
    ok "상세 조회 (DB에 저장된 결과를 다시 읽음)"
    echo "$detail" | jq -r '.data.detail.choices[0].order_messages[0].text' | sed 's/^/    /'
  else
    no "상세 조회 실패: $(echo "$detail" | jq -c . 2>/dev/null)"
  fi
}

step8() {
  title 8 "구매 나머지 시연 (1002 예산 부족 · 1003 재고 빈칸 · 1004 거래처 4곳 · 1005 거래처 12곳)"
  local b
  b=$(run_purchase 1002 100201)
  echo "$b" | jq -e '.status == "infeasible" and .data.violations[0].constraint == "budget"' >/dev/null 2>&1 \
    && ok "1002 infeasible: $(echo "$b" | jq -r .message)" || no "1002 응답: $(echo "$b" | jq -c . 2>/dev/null)"
  b=$(run_purchase 1003 100301)
  echo "$b" | jq -e '.status == "needs_input" and .data.missing_fields[0].path == "items[1].usable_inventory"' >/dev/null 2>&1 \
    && ok "1003 needs_input: $(echo "$b" | jq -r .message)" || no "1003 응답: $(echo "$b" | jq -c . 2>/dev/null)"
  b=$(run_purchase 1004 100401)
  echo "$b" | jq -e '.status == "ok" and .data.summary.choices[0].total_krw == 125500 and .data.summary.choices[1].total_krw == 127500' >/dev/null 2>&1 \
    && ok "1004 거래처 4곳: 안 1 125,500원 · 안 2 127,500원 · 기준선 $(echo "$b" | jq -r .data.summary.baseline.total_krw)원" \
    || no "1004 응답: $(echo "$b" | jq -c . 2>/dev/null)"
  b=$(run_purchase 1005 100501)
  echo "$b" | jq -e '.status == "ok" and .data.summary.choices[0].total_krw == 113280 and .data.summary.choices[1].total_krw == 127500' >/dev/null 2>&1 \
    && ok "1005 거래처 12곳: 안 1 113,280원 · 안 2 127,500원 · 기준선 $(echo "$b" | jq -r .data.summary.baseline.total_krw)원" \
    || no "1005 응답: $(echo "$b" | jq -c . 2>/dev/null)"
}

step9() {
  title 9 "같은 요청 키로 두 번 보내면 결과는 하나 (X-Request-Key)"
  local key a b n
  key="local-check-$(date +%s)"
  a=$(run_purchase 1001 100101 "$key" | jq -r .data.result_id)
  b=$(run_purchase 1001 100101 "$key" | jq -r .data.result_id)
  n=$(psql_q "select count(*) from work_result where input_version_id = 100101 and request_key = '$key'")
  [ "$a" = "$b" ] && [ "$n" = "1" ] && ok "두 번 모두 result_id $a, 저장 1건" || no "result_id $a / $b, 저장 ${n:-?}건"
}

step10() {
  title 10 "FastAPI 실행 기록 (execution_log, 최근 구매 5건)"
  local rows
  rows=$(psql_q "select to_char(created_at at time zone 'Asia/Seoul', 'HH24:MI:SS') || '  ' || status || '  ' || coalesce(payload_json->>'response_status', '') from execution_log where name = 'purchase' order by created_at desc limit 5")
  if [ -n "$rows" ]; then ok "구매 도구 호출이 기록됨"; echo "$rows" | sed 's/^/    /'; else no "기록 없음" "7~9단계를 먼저 돌리세요"; fi
}

STEPS=("$@")
[ ${#STEPS[@]} -eq 0 ] && STEPS=(0 1 2 3 4 5 6 7 8 9 10)
for n in "${STEPS[@]}"; do
  if declare -f "step$n" >/dev/null; then "step$n"; else echo "없는 단계: $n (0~10)"; fi
done
echo
echo "결과: 통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ]
