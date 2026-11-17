# 운영 합성 예제

- input.json: 영업일·직원·근무·시급·반복 가정. 전부 가상의 비식별 데이터.
- schedule_request.json, cost_request.json, expected_cost.json: labor 실제 계산기로 만든 입력·예상 비용.
- simulation_request.json, compare_response.json: 가영님 연결 검토용 **합성 계약 예제**. 실제 SimPy 30회 결과 아님.
- preview.json, frontend/src/features/operation/demo.json: 같은 화면 예제. 대기/통계/추천과 이벤트는 합성·부분 예시, 배치·비용은 labor로 갱신.
- ALT_C 추가 근무는 11:30~13:30 2시간, 시급10,320원, 주휴/보험 제외.
- fixture의 통계 정책 문자열은 예시이며 실제 집계 정책은 가영님 확인 필요.
- 갱신은 ai-server에서 PYTHONPATH=. python scripts/refresh_operation_demo.py.
