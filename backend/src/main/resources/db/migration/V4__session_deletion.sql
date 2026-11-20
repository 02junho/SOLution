-- 업무 삭제는 확정 계획·계산 근거를 보존하고 이어하기와 대화 접근을 막는다.
ALTER TABLE work_session ADD COLUMN deleted_at TIMESTAMPTZ;
