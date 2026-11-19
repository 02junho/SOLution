-- 화면 단계와 별도로 동시 운영 계산 수를 추적한다. 세션 행 잠금 안에서 등록·정리한다.
ALTER TABLE work_session ADD COLUMN active_operation_runs INTEGER NOT NULL DEFAULT 0
    CHECK (active_operation_runs >= 0);
