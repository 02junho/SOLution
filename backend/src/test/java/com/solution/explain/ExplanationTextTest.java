package com.solution.explain;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

@SuppressWarnings("unchecked")
class ExplanationTextTest {

	@Test
	void 금액에_천_단위_쉼표를_넣고_소수점_영은_뺀다() {
		assertThat(ExplanationText.text("하루 인건비가 113520원이고 평균 8.7분, 48.0%예요. 근무 24.0시간", false))
				.isEqualTo("하루 인건비가 113,520원이고 평균 8.7분, 48%예요. 근무 24시간");
		assertThat(ExplanationText.text("이미 113,280원이고 2.5%와 3회", false))
				.isEqualTo("이미 113,280원이고 2.5%와 3회");
	}

	@Test
	void 템플릿의_이가와_합니다체를_해요체로_바꾼다() {
		assertThat(ExplanationText.text("총비용 최소이(가) 113,280원으로 가장 쌉니다(다음 안보다 14,220원 적음).", false))
				.isEqualTo("총비용 최소가 113,280원으로 가장 싸요. 다음 안보다 14,220원 적어요.");
		assertThat(ExplanationText.text("1안이(가) 1000원", false)).isEqualTo("1안이 1,000원");
		assertThat(ExplanationText.text("가장 싼 두 안의 총액이 113,520원으로 같습니다.", false))
				.isEqualTo("가장 싼 두 안의 총액이 113,520원으로 같아요.");
		assertThat(ExplanationText.text("실제 효과를 보장하지 않습니다.", false)).isEqualTo("실제 효과를 보장하지 않아요.");
	}

	@Test
	void 합니다체_끝맺음을_해요체로_맞춘다() {
		assertThat(ExplanationText.text("총 113280원, 배송 2회로 계산되었습니다.", false))
				.isEqualTo("총 113,280원, 배송 2회로 계산됐어요.");
		assertThat(ExplanationText.text("확정할 수 없는 참고용입니다. 결과입니다.", false))
				.isEqualTo("확정할 수 없는 참고용이에요. 결과예요.");
		assertThat(ExplanationText.text("가정이 적용되었습니다. 차이가 없습니다. 제외했습니다.", false))
				.isEqualTo("가정이 적용됐어요. 차이가 없어요. 제외했어요.");
		assertThat(ExplanationText.text("이미 해요체예요.", false)).isEqualTo("이미 해요체예요.");
	}

	@Test
	void 운영은_화면의_안_이름으로_되돌리고_첫_줄을_추천_안으로_만든다() {
		assertThat(ExplanationText.text("직원 추가는 하루 인건비가 144480원이에요.", true))
				.isEqualTo("한 명 추가는 하루 인건비가 144,480원이에요.");
		assertThat(ExplanationText.operationHeadline(Map.of("recommended_choice_key", "ALT_C")))
				.isEqualTo("모의 조건으로 세 안을 비교했어요. 추천한 안은 한 명 추가예요.");
		assertThat(ExplanationText.operationHeadline(Map.of("recommended_choice_key", "CURRENT")))
				.isEqualTo("모의 조건으로 세 안을 비교했어요. 추천한 안은 현재 방식이에요.");
		Map<String, Object> none = new HashMap<>();
		none.put("recommended_choice_key", null);
		assertThat(ExplanationText.operationHeadline(none)).contains("추천한 안은 없어요");
	}

	@Test
	void 경고와_겹치는_주의와_같은_주의는_한_번만_남긴다() {
		Map<String, Object> data = Map.of("source", "llm", "explanation", Map.of(
				"headline", "모의 조건: 가장 싼 두 안의 총액이 113,520원으로 같습니다.",
				"per_choice", List.of(Map.of("choice_key", "ALT_C", "text", "직원 추가는 144480원이에요.")),
				"warnings_echo", List.of(Map.of("warning_id", "SIMULATED_CONDITIONS",
						"message", "모의 조건: 가정에 근거한 값이며 실제 매장과 다를 수 있어요.")),
				"caveats", List.of("모의 조건에 따른 시뮬레이션 결과이며 실제 효과를 보장하지 않습니다.",
						"이 결과는 가정에 근거한 모의 조건이라 실제 매장과 다를 수 있어요.",
						"휴게는 반영하지 않았어요.", "휴게는 반영하지 않았어요.")));

		Map<String, Object> out = ExplanationText.polish(data, "operation", Map.of("recommended_choice_key", "ALT_C"));

		Map<String, Object> explanation = (Map<String, Object>) out.get("explanation");
		assertThat(explanation.get("headline")).isEqualTo("모의 조건으로 세 안을 비교했어요. 추천한 안은 한 명 추가예요.");
		assertThat((List<Map<String, Object>>) explanation.get("per_choice")).singleElement()
				.satisfies(row -> assertThat(row).containsEntry("text", "한 명 추가는 144,480원이에요."));
		assertThat((List<String>) explanation.get("caveats")).containsExactly(
				"모의 조건에 따른 시뮬레이션 결과이며 실제 효과를 보장하지 않아요.", "휴게는 반영하지 않았어요.");
		assertThat(out).containsEntry("source", "llm");
	}

	@Test
	void 매입_설명에는_모의_조건_주의를_남기지_않는다() {
		Map<String, Object> data = Map.of("source", "llm", "explanation", Map.of("headline", "총비용 최소: 113,280원.",
				"per_choice", List.of(), "warnings_echo", List.of(),
				"caveats", List.of("이 결과는 모의 조건으로 계산한 것이며 실제 운영과 다를 수 있어요.",
						"거래처 1곳을 배송 1회로 보는 가정이 적용되었습니다.")));

		Map<String, Object> explanation = (Map<String, Object>) ExplanationText.polish(data, "purchase", Map.of())
				.get("explanation");

		assertThat((List<String>) explanation.get("caveats")).containsExactly("거래처 1곳을 배송 1회로 보는 가정이 적용됐어요.");
	}
}
