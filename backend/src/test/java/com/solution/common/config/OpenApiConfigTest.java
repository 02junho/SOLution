package com.solution.common.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.Test;

import com.solution.purchase.dto.PurchaseRunRequest;

import io.swagger.v3.core.converter.ModelConverters;
import io.swagger.v3.oas.models.media.Schema;

class OpenApiConfigTest {

	@Test
	void 문서의_필드_이름은_실제_JSON처럼_snake_case() {
		ModelConverters converters = new ModelConverters();
		converters.addConverter(new OpenApiConfig().snakeCaseModelResolver());

		@SuppressWarnings("rawtypes")
		Map<String, Schema> schemas = converters.readAll(PurchaseRunRequest.class);

		Schema<?> request = schemas.get("PurchaseRunRequest");
		assertThat(request.getProperties()).containsOnlyKeys("input_version_id");
		assertThat(request.getRequired()).containsExactly("input_version_id");
	}
}
