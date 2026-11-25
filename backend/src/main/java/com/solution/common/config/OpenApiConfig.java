package com.solution.common.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;

import io.swagger.v3.core.jackson.ModelResolver;
import io.swagger.v3.core.util.Json;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;

/** Swagger 화면(/docs) 설정. 요청·응답의 자세한 규칙은 노션 API 명세서가 기준이다. */
@Configuration
public class OpenApiConfig {

	@Bean
	OpenAPI solutionOpenApi() {
		return new OpenAPI().info(new Info()
				.title("SOLution API")
				.version("v1")
				.description("화면이 부르는 Spring 주소(/api/v1/...). 공통 응답 {status, data, message}, JSON 필드는 snake_case. "
						+ "응답 data의 자세한 칸과 예시는 노션 API 명세서를 기준으로 한다."));
	}

	/**
	 * 앱은 Jackson 3 설정(spring.jackson.property-naming-strategy)으로 snake_case JSON을 쓰지만,
	 * Swagger는 자체 Jackson 2로 필드 이름을 읽어서 inputVersionId처럼 보인다. 문서도 실제 JSON과 같게 snake_case로 맞춘다.
	 */
	@Bean
	ModelResolver snakeCaseModelResolver() {
		return new ModelResolver(Json.mapper().copy().setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE));
	}
}
