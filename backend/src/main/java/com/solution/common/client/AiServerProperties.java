package com.solution.common.client;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** application.yml의 ai-server.* 설정 */
@ConfigurationProperties(prefix = "ai-server")
public record AiServerProperties(String url, Duration connectTimeout, Duration readTimeout) {
}
