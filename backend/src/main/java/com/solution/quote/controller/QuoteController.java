package com.solution.quote.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.solution.quote.dto.*;
import com.solution.quote.service.*;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/stores/{storeId}")
public class QuoteController {
    private final CatalogService catalog;
    private final QuoteService quotes;
    private final MaterialRequirementService materials;

    public QuoteController(CatalogService catalog, QuoteService quotes, MaterialRequirementService materials) {
        this.catalog = catalog;
        this.quotes = quotes;
        this.materials = materials;
    }

    // 품목 사전 등록
    /*
    {
  "version": 1,
  "items": [
    {"item_id": "milk", "name": "우유", "base_unit": "ml", "aliases": ["흰우유"]},
    {"item_id": "bean", "name": "원두", "base_unit": "g", "aliases": []}
  ]
}
이후 견적 원문에 ‘흰우유’라고 쓰여 있어도, 품목 정리 단계에서 재료표와 재고가 사용하는 `milk`에 연결할 수 있음
    */
    @PostMapping("/items")
    @ResponseStatus(HttpStatus.CREATED)
    JsonNode createDictionary(@PathVariable String storeId, @Valid @RequestBody Dictionary body) {
        return catalog.createDictionary(storeId, body);
    }

    // 품목 사전 조회 (저장된 최신 버전의 사전을 확인할 수 있음)
    @GetMapping("/items")
    JsonNode getItems(@PathVariable String storeId) {
        return catalog.getItems(storeId);
    }

    // 재료표 저장 (재료표·판매 계획·재고 등록) → 필요량 계산에 사용할 입력 준비
    // 한 잔에 재료가 얼마나 들어가는지 등록
    /*
    {
  "recipes": {
    "americano": [
      {"item_id": "bean", "unit": "g", "amount_per_cup": 18, "scope": "all"}
    ],
    "latte": [
      {"item_id": "bean", "unit": "g", "amount_per_cup": 18, "scope": "all"},
      {"item_id": "milk", "unit": "ml", "amount_per_cup": 200, "scope": "all"}
    ]
  }
}

Spring은 품목 ID와 단위가 사전에 등록된 값과 일치하는지 검사합니다. 예를 들어 milk의 기준 단위가 ml이므로
0.2 L로 보내면 거절되고, 200 ml로 보내야 합니다. 성공하면 저장한 재료표를 반환합니다.
    */
    @PutMapping("/recipes")
    JsonNode putRecipes(@PathVariable String storeId, @Valid @RequestBody Recipes body) {
        return catalog.putRecipes(storeId, body);
    }

    // 재료표 조회
    @GetMapping("/recipes")
    JsonNode getRecipes(@PathVariable String storeId) {
        return catalog.getRecipes(storeId);
    }

    //작업별 판매 계획, 실적 저장(판매 실적과 이번 주 계획 등록)
    /*
    {
  "start_date": "2026-11-16",
  "end_date": "2026-11-22",
  "recent_actuals": [
    {"menu_id": "americano", "cups": 90, "start_date": "2026-11-09", "end_date": "2026-11-15"}
  ],
  "sales_plan": [
    {"menu_id": "americano", "cups": 100},
    {"menu_id": "latte", "cups": 50}
  ]
}

Spring은 날짜 순서와 계획에 중복 메뉴가 있는지 확인한 뒤 작업 ID별로 저장합니다. 다음 단계에서 원두 필요량을 계산할 때는 지난주 실제 판매량 90잔이 아니라 이번 주 계획 100잔을 사용합니다.
    */

    @PutMapping("/purchase-preparations/{id}/sales-plan")
    JsonNode putSales(@PathVariable String storeId, @PathVariable UUID id, @Valid @RequestBody Sales body) {
        return catalog.putSales(storeId, id, body);
    }

    //작업별 판매 계획, 실적 조회
    @GetMapping("/purchase-preparations/{id}/sales-plan")
    JsonNode getSales(@PathVariable String storeId, @PathVariable UUID id) {
        return catalog.getSales(storeId, id);
    }

    // 매장 재고 저장(현재 가용 재고와 목표 안전재고 등록)
/*
{
  "inventory": {
    "bean": {"unit": "g", "usable_inventory": 1000, "safety_stock": 500},
    "milk": {"unit": "ml", "usable_inventory": 2000, "safety_stock": 1000}
  }
}

Spring은 음수 재고와 사전에 맞지 않는 단위를 검사하고, 매장 재고를 저장합니다. 여기까지는 기준 데이터를 준비하는 과정이라 FastAPI를 호출하지 않습니다.
*/
    @PutMapping("/inventory")
    JsonNode putInventory(@PathVariable String storeId, @Valid @RequestBody Stocks body) {
        return catalog.putInventory(storeId, body);
    }

    // 자연어 견적 분석(견적 분석 API 호출 → 원문을 구매 비교에 쓸 수 있는 데이터로 정리)
    /*
    {
    "text": "흰우유 1L 12개입 한 박스 29,000원",
    "supplier_name": "A식자재",
    "use_rag": false
    }

    1. Spring QuoteController가 JSON을 Analyze DTO로 받고, 견적 원문이 비어 있지 않은지 검사합니다.
    2. Spring QuoteService가 QuoteToolsClient로 FastAPI의 POST /tools/quote/parse를 호출합니다.
    FastAPI는 원문에서 흰우유, 1L, 12개입, 29,000원을 추출합니다.
    3. Spring이 DB에서 매장의 최신 품목 사전을 읽어 추출 결과와 함께 POST /tools/quote/normalize를 호출합니다.
     FastAPI는 별칭 흰우유를 milk에 연결하고 `1,000ml × 12 = 12,000ml/박스`로 환산합니다. 이 예시는 사전에 정확한 별칭이 있으므로 RAG 없이도 연결됩니다.
    4. Spring이 quote_batch_id를 발급하고 정리된 견적과 추출된 판매량 후보·배송 조건을 저장한 뒤 응답합니다.


    응답
    {
  "quote_batch_id": "8d87f6fd-3f37-4cba-b643-4f821c38130b",
  "normalization": {
    "dictionary_version": 1,
    "items": [
      {
        "item_id": "milk",
        "supplier_name": "A식자재",
        "normalized_quantity_per_pack": 12000,
        "normalized_unit": "ml",
        "pack_price": 29000,
        "vat_status": "unknown",
        "comparable": true
      }
    ]
  },
  "sales_candidates": [],
  "delivery": [],
  "confirmations": {}
}
    */
    @PostMapping("/purchase-preparations/{id}/quotes/analyze")
    JsonNode analyze(@PathVariable String storeId, @PathVariable UUID id, @Valid @RequestBody Analyze body) {
        return quotes.analyze(storeId, id, body);
    }

    // 직접 입력 견적 처리
    @PostMapping("/purchase-preparations/{id}/quotes/manual")
    JsonNode manual(@PathVariable String storeId, @PathVariable UUID id, @Valid @RequestBody ManualQuote body) {
        return quotes.manual(storeId, id, body);
    }

    // 저장된 분석 묶음 조회
    @GetMapping("/purchase-preparations/{id}/quotes/{batch}")
    JsonNode getQuotes(@PathVariable String storeId, @PathVariable UUID id, @PathVariable UUID batch) {
        return quotes.getQuotes(storeId, id, batch);
    }

    // 거래처별 확인 상태 변경
    @PatchMapping("/purchase-preparations/{id}/quotes/{batch}/confirmation")
    JsonNode confirm(@PathVariable String storeId, @PathVariable UUID id, @PathVariable UUID batch,
                     @RequestParam String supplierName, @Valid @RequestBody Confirmation body) {
        return quotes.confirm(storeId, id, batch, supplierName, body);
    }

    // 총 필요량, 재고 미리보기(재료 필요량 미리보기 → 판매 계획으로 계산한 수량과 재고를 함께 반환) -> 3번 작업자에게 넘김
    @PostMapping("/purchase-preparations/{id}/material-requirements/preview")
    JsonNode preview(@PathVariable String storeId, @PathVariable UUID id) {
        return materials.preview(storeId, id);
    }
}
