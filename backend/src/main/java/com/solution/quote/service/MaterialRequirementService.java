package com.solution.quote.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;

import com.solution.quote.client.QuoteToolsClient;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MaterialRequirementService { // 총 필요량에 재고 정보 붙이기
    private final QuoteResourceService resources;
    private final QuoteToolsClient tools;

    public MaterialRequirementService(QuoteResourceService resources, QuoteToolsClient tools) {
        this.resources = resources;
        this.tools = tools;
    }

    // DB의 판매 데이터에서 sales_plan만 골라 메뉴 재료표와 함께 /tools/quote/requirements에 보냄
    //그 후 FastAPI가 반환한 품목별 gross_need에 같은 품목·단위의 usable_inventory와 safety_stock을 붙임
    /*
    예를 들어 아메리카노 100잔과 라떼 50잔에 모두 원두 18g이 들어가면,
    반환되는 원두 한 행은 다음과 같습니다. 이해하기 쉽게 사용량 상세 목록은 생략했습니다.
    {
        "item_id": "bean",
        "unit": "g",
        "gross_need": 2700,
        "usable_inventory": 1000,
        "safety_stock": 500
    }

    여기서 총 필요량은 2,700g 그대로입니다.
    재고 차감과 포장 단위 올림은 이후 구매 최적화가 맡습니다.
    재고 문서는 있지만 해당 품목이 없거나 단위가 다르면 두 재고 값을 null로 두고
    needs_input과 확인 사유를 반환합니다. 반면, 매장의 재고 문서 자체가 없으면 현재 구현에서는 404가 반환됩니다.
    */
    public JsonNode preview(String storeId, UUID id) {
        var calculated = (ObjectNode) tools.call("requirements", Map.of(
            "sales_plan", resources.read(storeId, "sales:" + id).get("sales_plan"),
            "recipes", resources.read(storeId, "recipes").get("recipes")));
        var stock = resources.read(storeId, "inventory").get("inventory");
        for (var value : calculated.withArray("items")) {
            var row = (ObjectNode) value;
            var current = stock.get(row.get("item_id").asText());
            if (current == null || !row.get("unit").equals(current.get("unit"))) {
                row.putNull("usable_inventory").putNull("safety_stock");
                calculated.put("status", "needs_input");
                calculated.withArray("issues").addObject().put("code", "INVENTORY_MISSING_OR_UNIT_MISMATCH")
                    .put("item_id", row.get("item_id").asText());
            } else {
                row.set("usable_inventory", current.get("usable_inventory"));
                row.set("safety_stock", current.get("safety_stock"));
            }
        }
        return calculated;
    }
}
