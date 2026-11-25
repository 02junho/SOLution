# 가영·현식 연결 검토용 예제

`ga_young_staffing_only.json`은 가영 공유 텍스트의24/27시간 배치를 재현합니다. 사장님 여부·시급·휴게를 추정하지 않으며 급여 입력이 아닙니다.
그 외 파일은 별도의 명시적 급여 연결 가정입니다. B10~19시와무급휴게1시간, C11~14시로 기본급 추가30,960원을 검증합니다.
두 예제는 같은 하루 근무표가 아닙니다. 원래2시간 추가 예제는 상위 폴더에 보존했습니다.

`staffing_schema_version`과직원 JSON은 팀 합의 전 제안입니다. 새 입력 버전에서 명시적으로 사용합니다.
통계·추천은 합성 예시이며 실제 SimPy를 실행하지 않습니다. `closing:null`은 판정 미제공입니다.

재생성: `cd ai-server` 후 `PYTHONPATH=. python scripts/refresh_staffing_proposal.py`.
