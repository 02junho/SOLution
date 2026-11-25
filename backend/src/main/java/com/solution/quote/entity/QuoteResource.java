package com.solution.quote.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "quote_demo_resource")
@IdClass(QuoteResourceId.class)
public class QuoteResource {
    @Id
    @Column(name = "store_id")
    private String storeId;

    @Id
    @Column(name = "resource_key")
    private String resourceKey;

    @Id
    private int version;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private JsonNode payload; // payload는 PostgreSQL jsonb

    protected QuoteResource() {}

    public JsonNode getPayload() {
        return payload.deepCopy();
    }
}
