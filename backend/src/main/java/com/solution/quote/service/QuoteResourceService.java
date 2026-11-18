package com.solution.quote.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.solution.quote.entity.QuoteResource;
import com.solution.quote.repository.QuoteResourceRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import com.solution.common.exception.ApiException;

@Service
class QuoteResourceService {
    private final QuoteResourceRepository repository;
    private final ObjectMapper json;

    QuoteResourceService(QuoteResourceRepository repository, ObjectMapper json) {
        this.repository = repository;
        this.json = json;
    }

    //가장 높은 저장 버전의 JSON을 꺼내고, 데이터가 없으면 404 Not Found를 반환
    JsonNode read(String store, String key) {
        return repository.findFirstByStoreIdAndResourceKeyOrderByVersionDesc(store, key)
            .map(QuoteResource::getPayload).orElseThrow(() -> missing(key));
    }

    JsonNode readForUpdate(String store, String key) {
        return repository.findCurrentForUpdate(store, key)
            .map(QuoteResource::getPayload).orElseThrow(() -> missing(key));
    }

    // ObjectMapper.valueToTree()로 DTO를 Jackson JSON 트리로 바꾼 뒤 저장
    JsonNode save(String store, String key, Object body) {
        JsonNode payload = json.valueToTree(body);
        repository.upsertCurrent(store, key, payload.toString());
        return payload;
    }

    // insertVersion()은 사전의 새 버전을 등록할 때, readForUpdate()는 견적 확인 전에 잠금을 걸어 읽을 때 사용
    int insertVersion(String store, String key, int version, JsonNode payload) {
        return repository.insertVersion(store, key, version, payload.toString());
    }

    /*
    private static ResponseStatusException missing(String key) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "입력 없음: " + key);
    }
*/
    private static ApiException missing(String key) {
        return ApiException.notFound("입력 없음: " + key);
    }
}
