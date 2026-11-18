package com.solution.quote.client;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;


    /*
Value("\${quote.tools-url}")로 FastAPI 기본 주소를 받습니다. call("parse", request)처럼 부르면 POST /tools/quote/parse로 전송하고, 응답을 Jackson의 JsonNode로 읽습니다. 연결 제한은 3초, 응답 읽기 제한은 45초입니다. 연결·HTTP 오류나 빈 응답은 Spring에서 502 Bad Gateway로 변환됩니다. 이 구현에서는 FastAPI의 422 같은 오류 상태도 그대로 화면에 전달되지 않고 502로 매핑
    */

@Component
public class QuoteToolsClient { // Spring에서 FastAPI를 호출하는 곳

    private final RestClient tools;
    private final ObjectMapper json;

    public QuoteToolsClient(
            @Value("${quote.tools-url}") String url,
            ObjectMapper json
    ) {
        this.json = json;

        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(3000);
        factory.setReadTimeout(45000);

        this.tools = RestClient.builder()
                .baseUrl(url)
                .requestFactory(factory)
                .build();
    }

    public JsonNode call(String action, Object request) {
        try {
            String requestBody = json.writeValueAsString(request);

            String responseBody = tools.post()
                    .uri("/tools/quote/" + action)
                    .contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.APPLICATION_JSON)
                    .body(requestBody)
                    .retrieve()
                    .body(String.class);

            if (responseBody == null || responseBody.isBlank()) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_GATEWAY, "견적 도구 응답이 비어 있습니다: " + action);
            }

            return json.readTree(responseBody);
        } catch (JsonProcessingException | RestClientException e) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_GATEWAY, "견적 도구 호출 실패: " + action, e);
        }
    }
}