package com.solution.quote.entity;

import java.io.Serializable;
import java.util.Objects;

/** 매장, 데이터 종류, 버전으로 저장 행을 구분한다. */
public class QuoteResourceId implements Serializable {
    private String storeId;
    private String resourceKey;
    private int version;

    public QuoteResourceId() {}

    public QuoteResourceId(String storeId, String resourceKey, int version) {
        this.storeId = storeId;
        this.resourceKey = resourceKey;
        this.version = version;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof QuoteResourceId id
            && version == id.version
            && Objects.equals(storeId, id.storeId)
            && Objects.equals(resourceKey, id.resourceKey);
    }

    @Override
    public int hashCode() {
        return Objects.hash(storeId, resourceKey, version);
    }
}
