package com.solution.quote.repository;


import com.solution.quote.entity.QuoteResource;
import com.solution.quote.entity.QuoteResourceId;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.*;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface QuoteResourceRepository extends JpaRepository<QuoteResource, QuoteResourceId> {
    Optional<QuoteResource> findFirstByStoreIdAndResourceKeyOrderByVersionDesc(String storeId, String resourceKey);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from QuoteResource r where r.storeId = :store and r.resourceKey = :key and r.version = 1")
    Optional<QuoteResource> findCurrentForUpdate(@Param("store") String storeId, @Param("key") String key);

    @Modifying(clearAutomatically = true)
    @Transactional
    @Query(value = """
        INSERT INTO quote_demo_resource(store_id, resource_key, version, payload)
        VALUES (:store, :key, :version, CAST(:payload AS jsonb))
        ON CONFLICT (store_id, resource_key, version) DO NOTHING
        """, nativeQuery = true)
    int insertVersion(@Param("store") String store, @Param("key") String key,
                      @Param("version") int version, @Param("payload") String payload);

    @Modifying(clearAutomatically = true)
    @Transactional
    @Query(value = """
        INSERT INTO quote_demo_resource(store_id, resource_key, version, payload)
        VALUES (:store, :key, 1, CAST(:payload AS jsonb))
        ON CONFLICT (store_id, resource_key, version) DO UPDATE SET payload = EXCLUDED.payload
        """, nativeQuery = true)
    int upsertCurrent(@Param("store") String store, @Param("key") String key, @Param("payload") String payload);
}
