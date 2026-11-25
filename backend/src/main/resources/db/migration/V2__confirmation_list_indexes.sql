-- 확정 목록 명세의 조회 인덱스. V1을 수정하지 않고 추가한다.
CREATE INDEX ix_confirmation_store_feature
    ON work_confirmation (store_id, feature_type, confirmed_at DESC, confirmation_id DESC);
CREATE INDEX ix_confirmation_session
    ON work_confirmation (session_id, confirmed_at DESC, confirmation_id DESC);
