package com.solution.quote.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.solution.quote.dto.*;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@Service
public class CatalogService {
    private final QuoteResourceService resources;
    private final ObjectMapper json;

    public CatalogService(QuoteResourceService resources, ObjectMapper json) {
        this.resources = resources;
        this.json = json;
    }

    public JsonNode createDictionary(String storeId, Dictionary body) {
        var ids = new HashSet<String>();
        var clean = new ArrayList<Item>();
        for (var item : body.items()) {
            require(ids.add(item.item_id()), "중복 품목 ID");
            clean.add(new Item(item.item_id(), item.name(), item.base_unit(),
                item.aliases() == null ? List.of() : item.aliases(),
                item.specifications() == null ? List.of() : item.specifications()));
        }
        JsonNode payload = json.valueToTree(new Dictionary(body.version(), clean));
        int inserted = resources.insertVersion(storeId, "items", body.version(), payload);
        if (inserted == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "이미 있는 사전 버전");
        return payload;
    }

    public JsonNode getItems(String storeId) { return resources.read(storeId, "items"); }

    public JsonNode putRecipes(String storeId, Recipes body) {
        var dict = units(storeId);
        body.recipes().values().forEach(lines -> lines.forEach(line ->
            require(line.unit().equals(dict.get(line.item_id())), "재료표 품목 또는 기준 단위 오류")));
        return resources.save(storeId, "recipes", body);
    }

    public JsonNode getRecipes(String storeId) { return resources.read(storeId, "recipes"); }

    public JsonNode putSales(String storeId, UUID id, Sales body) {
        require(!body.end_date().isBefore(body.start_date()), "판매 계획 기간 오류");
        for (var actual : body.recent_actuals())
            require(!actual.end_date().isBefore(actual.start_date()), "판매 실적 기간 오류");
        var menus = new HashSet<String>();
        for (var plan : body.sales_plan()) {
            require(menus.add(plan.menu_id()), "중복 메뉴");
            require(plan.takeaway_cups() == null || plan.takeaway_cups() <= plan.cups(), "포장 잔수 오류");
        }
        return resources.save(storeId, "sales:" + id, body);
    }

    public JsonNode getSales(String storeId, UUID id) {
        return resources.read(storeId, "sales:" + id);
    }

    public JsonNode putInventory(String storeId, Stocks body) {
        var dict = units(storeId);
        body.inventory().forEach((id, value) ->
            require(value.unit().equals(dict.get(id)), "재고 품목 또는 기준 단위 오류"));
        return resources.save(storeId, "inventory", body);
    }

    private Map<String, String> units(String storeId) {
        var units = new HashMap<String, String>();
        resources.read(storeId, "items").get("items").forEach(item ->
            units.put(item.get("item_id").asText(), item.get("base_unit").asText()));
        return units;
    }

    private static void require(boolean ok, String message) {
        if (!ok) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
