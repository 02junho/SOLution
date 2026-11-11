package com.solution.common.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import com.solution.common.client.AiServerProperties;

@Configuration
@EnableConfigurationProperties(AiServerProperties.class)
public class AiServerClientConfig {

	@Bean
	RestClient aiServerRestClient(RestClient.Builder builder, AiServerProperties properties) {
		SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
		requestFactory.setConnectTimeout(properties.connectTimeout());
		requestFactory.setReadTimeout(properties.readTimeout());
		return builder
				.baseUrl(properties.url())
				.requestFactory(requestFactory)
				.build();
	}
}
