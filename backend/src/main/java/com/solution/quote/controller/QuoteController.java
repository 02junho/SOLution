package com.solution.quote.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.solution.quote.dto.*;
import com.solution.quote.service.*;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/stores/{storeId}")
public class QuoteController {
    private final CatalogService catalog;
    private final QuoteService quotes;
    private final MaterialRequirementService materials;

    public QuoteController(
            CatalogService catalog,
            QuoteService quotes,
            MaterialRequirementService materials
    ) {
        this.catalog = catalog;
        this.quotes = quotes;
        this.materials = materials;
    }

    @PostMapping("/items")
    ResponseEntity<String> createDictionary(
            @PathVariable String storeId,
            @Valid @RequestBody Dictionary body
    ) {
        return jsonResponse(HttpStatus.CREATED, catalog.createDictionary(storeId, body));
    }

    @GetMapping("/items")
    ResponseEntity<String> getItems(@PathVariable String storeId) {
        return jsonResponse(HttpStatus.OK, catalog.getItems(storeId));
    }

    @PutMapping("/recipes")
    ResponseEntity<String> putRecipes(
            @PathVariable String storeId,
            @Valid @RequestBody Recipes body
    ) {
        return jsonResponse(HttpStatus.OK, catalog.putRecipes(storeId, body));
    }

    @GetMapping("/recipes")
    ResponseEntity<String> getRecipes(@PathVariable String storeId) {
        return jsonResponse(HttpStatus.OK, catalog.getRecipes(storeId));
    }

    @PutMapping("/purchase-preparations/{id}/sales-plan")
    ResponseEntity<String> putSales(
            @PathVariable String storeId,
            @PathVariable UUID id,
            @Valid @RequestBody Sales body
    ) {
        return jsonResponse(HttpStatus.OK, catalog.putSales(storeId, id, body));
    }

    @GetMapping("/purchase-preparations/{id}/sales-plan")
    ResponseEntity<String> getSales(
            @PathVariable String storeId,
            @PathVariable UUID id
    ) {
        return jsonResponse(HttpStatus.OK, catalog.getSales(storeId, id));
    }

    @PutMapping("/inventory")
    ResponseEntity<String> putInventory(
            @PathVariable String storeId,
            @Valid @RequestBody Stocks body
    ) {
        return jsonResponse(HttpStatus.OK, catalog.putInventory(storeId, body));
    }

    @PostMapping("/purchase-preparations/{id}/quotes/analyze")
    ResponseEntity<String> analyze(
            @PathVariable String storeId,
            @PathVariable UUID id,
            @Valid @RequestBody Analyze body
    ) {
        return jsonResponse(HttpStatus.OK, quotes.analyze(storeId, id, body));
    }

    @PostMapping("/purchase-preparations/{id}/quotes/manual")
    ResponseEntity<String> manual(
            @PathVariable String storeId,
            @PathVariable UUID id,
            @Valid @RequestBody ManualQuote body
    ) {
        return jsonResponse(HttpStatus.OK, quotes.manual(storeId, id, body));
    }

    @GetMapping("/purchase-preparations/{id}/quotes/{batch}")
    ResponseEntity<String> getQuotes(
            @PathVariable String storeId,
            @PathVariable UUID id,
            @PathVariable UUID batch
    ) {
        return jsonResponse(HttpStatus.OK, quotes.getQuotes(storeId, id, batch));
    }

    @PatchMapping("/purchase-preparations/{id}/quotes/{batch}/confirmation")
    ResponseEntity<String> confirm(
            @PathVariable String storeId,
            @PathVariable UUID id,
            @PathVariable UUID batch,
            @RequestParam String supplierName,
            @Valid @RequestBody Confirmation body
    ) {
        return jsonResponse(
                HttpStatus.OK,
                quotes.confirm(storeId, id, batch, supplierName, body)
        );
    }

    @PostMapping("/purchase-preparations/{id}/material-requirements/preview")
    ResponseEntity<String> preview(
            @PathVariable String storeId,
            @PathVariable UUID id
    ) {
        return jsonResponse(HttpStatus.OK, materials.preview(storeId, id));
    }

    private ResponseEntity<String> jsonResponse(HttpStatus status, JsonNode body) {
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body.toString());
    }
}