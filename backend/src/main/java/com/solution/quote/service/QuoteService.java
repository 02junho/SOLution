package com.solution.quote.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;

import com.solution.quote.client.QuoteToolsClient;
import com.solution.quote.dto.Analyze;
import com.solution.quote.dto.Confirmation;
import com.solution.quote.dto.ManualQuote;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;

@Service
public class QuoteService { // 견적 분석과 저장
    private final QuoteResourceService resources;
    private final ObjectMapper json;
    private final QuoteToolsClient tools;

    public QuoteService(QuoteResourceService resources, ObjectMapper json, QuoteToolsClient tools) {
        this.resources = resources;
        this.json = json;
        this.tools = tools;
    }

    /*
   analyze() 호출 json 예시 :
   {
  "text": "흰우유 1L 12개입 한 박스 29,000원",
  "supplier_name": "A식자재",
  "use_rag": false
    }

   analyze()가 text, supplier_name을 FastAPI의 /tools/quote/parse에 보냄
    use_rag는 이 단계가 아니라 품목 정리 단계에서 사용. 생략하거나 null이면 정규화 요청에서 RAG 사용을 허용
    **/

    public JsonNode analyze(String storeId, UUID id, Analyze body) {
        var parseInput = json.createObjectNode().put("text", body.text());
        if (body.supplier_name() != null) parseInput.put("supplier_name", body.supplier_name());
        return saveQuoteBatch(storeId, id, tools.call("parse", parseInput),
            !Boolean.FALSE.equals(body.use_rag()));
    }

    // manual()은 입력 DTO를 FastAPI 정규화 도구가 받을 형태로 바꿈
    // LLM 추출을 생략하고, use_rag=false로 같은 정규화 과정을 거칩니다. 그래서 직접 입력도 12,000ml/박스처럼 같은 기준으로 정리
    public JsonNode manual(String storeId, UUID id, ManualQuote body) {
        var extracted = json.createObjectNode();
        var items = extracted.putArray("items");
        for (var line : body.items()) {
            ObjectNode row = json.valueToTree(line);
            row.put("source_text", "직접 입력: " + line.raw_item_name());
            items.add(row);
        }
        extracted.putArray("sales");
        extracted.putArray("delivery");
        return saveQuoteBatch(storeId, id, extracted, false);
    }

    //작업 ID와 응답으로 받은 quote_batch_id로 저장된 결과를 읽음. 다시 분석을 요청하면 새 분석 묶음이 생김
    public JsonNode getQuotes(String storeId, UUID id, UUID batch) {
        return resources.read(storeId, "quotes:" + id + ":" + batch);
    }

    /*
   confirm()은 저장된 견적에 해당 거래처가 있는지 확인한 뒤 confirmations에 값을 기록합니다.
   예를 들어 {"A식자재": true}입니다.
    @Transactional 안에서 조회 잠금을 잡고 저장하기 때문에 같은
    분석 묶음에 대한 확인 요청이 동시에 들어와도 변경 사항이 서로 덮어쓰이는 것을 막습니다.
    이 확인은 거래처 견적을 검토했다는 표시이며, 우유의 부가세 여부나 레몬의 묶음 수량에 답하는 기능은 아닙니다.
    **/
    @Transactional
    public JsonNode confirm(String storeId, UUID id, UUID batch,
                     String supplierName, Confirmation body) {
        var key = "quotes:" + id + ":" + batch;
        var summary = (ObjectNode) resources.readForUpdate(storeId, key);
        boolean known = false;
        for (var line : summary.path("normalization").path("items"))
            known |= supplierName.equals(line.path("supplier_name").asText());
        require(known, "해당 견적의 거래처가 아닙니다.");
        ((ObjectNode) summary.get("confirmations")).put(supplierName, body.confirmed());
        return resources.save(storeId, key, summary);
    }

    // 해당 매장의 최신 품목 사전과 그 버전을 DB에서 읽음
    // 추출된 견적 행과 함께 /tools/quote/normalize에 전달
    // 사전에 흰우유가 milk의 별칭으로 등록돼 있다면 FastAPI는 이를 연결하고 1L × 12 = 12,000ml로 정리
    // Spring은 새 quote_batch_id를 만들고 normalization, sales_candidates, delivery, confirmations를 한 JSON에 묶어 저장
    // sales_candidates는 견적 원문에서 함께 추출된 판매량 후보이며, 여기서 판매 계획으로 자동 저장되지는 않음
    private JsonNode saveQuoteBatch(String storeId, UUID id, JsonNode extracted, boolean useRag) {
        var dict = resources.read(storeId, "items");
        var normalized = tools.call("normalize", Map.of("store_id", storeId,
            "dictionary_version", dict.get("version"), "dictionary", dict.get("items"),
            "items", extracted.get("items"), "use_rag", useRag));
        ObjectNode summary = json.createObjectNode().put("quote_batch_id", UUID.randomUUID().toString());
        summary.set("normalization", normalized);
        summary.set("sales_candidates", extracted.get("sales"));
        summary.set("delivery", extracted.get("delivery"));
        summary.set("confirmations", json.createObjectNode());
        // 분석할 때마다 별도 배치로 보존한다. 공통 입력 버전과 연결할 때는 팀 세션 서비스를 사용한다.
        return resources.save(storeId, "quotes:" + id + ":" + summary.get("quote_batch_id").asText(), summary);
    }

    private static void require(boolean ok, String message) {
        if (!ok) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
