package com.solution.session.service;

import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import com.solution.common.exception.ApiException;

/** Short transactions only: external calculations never hold a database lock. */
@Component
public class CalculationRuns {
    private static final Logger log = LoggerFactory.getLogger(CalculationRuns.class);
    private final JdbcTemplate jdbc;
    private final SessionRepository sessions;
    private final TransactionTemplate transactions;
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "calculation-leases");
        thread.setDaemon(true);
        return thread;
    });

    public CalculationRuns(JdbcTemplate jdbc, SessionRepository sessions, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
    }

    public Run start(long sessionId, String feature, Runnable validate) {
        UUID id = UUID.randomUUID();
        transactions.executeWithoutResult(status -> {
            sessions.lockSession(sessionId);
            recover(sessionId);
            validate.run();
            jdbc.update("INSERT INTO calculation_run VALUES (?, ?, ?, clock_timestamp() + interval '2 minutes')",
                    id, sessionId, feature);
            if (feature.equals("operation")) jdbc.update(
                    "UPDATE work_session SET active_operation_runs = active_operation_runs + 1 WHERE session_id = ?", sessionId);
        });
        return new Run(id, sessionId);
    }

    /** Caller holds the session lock. Expired requests are fenced from renewing or saving. */
    public void recover(long sessionId) {
        var expired = jdbc.query("DELETE FROM calculation_run WHERE session_id = ? AND lease_until <= clock_timestamp() RETURNING feature_type",
                (rs, row) -> rs.getString(1), sessionId);
        expired.forEach(feature -> {
                    if (feature.equals("operation")) decrement(sessionId);
                });
        if (!expired.isEmpty()) repairStep(sessionId);
    }

    private void repairStep(long sessionId) {
        // Only repair a tracked run; unrelated running stages remain protected.
        jdbc.update("""
                UPDATE work_session s SET step = CASE
                  WHEN EXISTS (SELECT 1 FROM work_confirmation c JOIN work_version v USING(input_version_id)
                    WHERE v.session_id=s.session_id AND v.version_no=s.current_version) THEN 'saved'
                  WHEN EXISTS (SELECT 1 FROM work_result r JOIN work_version v USING(input_version_id)
                    WHERE v.session_id=s.session_id AND v.version_no=s.current_version AND r.response_status='ok') THEN 'result'
                  ELSE 'review' END
                WHERE s.session_id=? AND s.step='running' AND s.active_operation_runs=0
                  AND NOT EXISTS (SELECT 1 FROM calculation_run WHERE session_id=s.session_id)
                """, sessionId);
    }

    public boolean active(long sessionId) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM calculation_run WHERE session_id=?)", Boolean.class, sessionId));
    }

    private void decrement(long sessionId) {
        jdbc.update("UPDATE work_session SET active_operation_runs=GREATEST(0, active_operation_runs-1) WHERE session_id=?", sessionId);
    }

    public final class Run implements AutoCloseable {
        private final UUID id;
        private final long sessionId;
        private final ScheduledFuture<?> renewal;
        private Run(UUID id, long sessionId) {
            this.id = id;
            this.sessionId = sessionId;
            renewal = heartbeat.scheduleWithFixedDelay(() -> {
                try {
                    jdbc.update("UPDATE calculation_run SET lease_until=clock_timestamp()+interval '2 minutes' WHERE run_id=? AND lease_until>clock_timestamp()", id);
                } catch (RuntimeException failure) {
                    log.warn("Calculation lease renewal failed for {}", id, failure);
                }
            }, 10, 10, TimeUnit.SECONDS);
        }
        public void requireActive() {
            if (!Boolean.TRUE.equals(jdbc.queryForObject(
                    "SELECT EXISTS (SELECT 1 FROM calculation_run WHERE run_id=? AND lease_until>clock_timestamp())", Boolean.class, id))) {
                throw ApiException.badRequest("CALCULATION_EXPIRED", "계산 연결이 끊어졌어요. 다시 계산해 주세요.");
            }
        }
        @Override public void close() {
            renewal.cancel(false);
            try {
                transactions.executeWithoutResult(status -> {
                    sessions.lockSession(sessionId);
                    var removed = jdbc.query("DELETE FROM calculation_run WHERE run_id=? RETURNING feature_type",
                            (rs, row) -> rs.getString(1), id);
                    removed.forEach(feature -> {
                                if (feature.equals("operation")) decrement(sessionId);
                            });
                    recover(sessionId);
                    if (!removed.isEmpty()) repairStep(sessionId);
                });
            } catch (RuntimeException failure) {
                // No further renewals: deletion/start will reclaim only this expired lease.
                log.warn("Calculation lease cleanup deferred for {}", id, failure);
            }
        }
    }

    @PreDestroy public void shutdown() { heartbeat.shutdownNow(); }
}
