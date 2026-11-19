-- Each request owns one renewable lease. Legacy counters are retained for plan-stage restoration.
CREATE TABLE calculation_run (
    run_id UUID PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES work_session(session_id) ON DELETE CASCADE,
    feature_type VARCHAR(20) NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL
);
CREATE INDEX calculation_run_session_idx ON calculation_run(session_id);
-- Requests from the previous process cannot survive its restart. Recover their counters lazily.
INSERT INTO calculation_run(run_id, session_id, feature_type, lease_until)
SELECT gen_random_uuid(), s.session_id, 'operation', clock_timestamp()
FROM work_session s CROSS JOIN LATERAL generate_series(1, s.active_operation_runs);
CREATE TABLE retired_confirmation_key (
    request_key VARCHAR(100) PRIMARY KEY,
    result_id BIGINT NOT NULL REFERENCES work_result(result_id) ON DELETE CASCADE
);
