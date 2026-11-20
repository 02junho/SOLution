package com.solution.explain;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * /agent/explain이 돌려준 설명을 화면에 넘기기 전에 표기와 말투만 다듬는다. 작성: 신준호
 *
 * <p>숫자 값과 안별 내용은 바꾸지 않는다. 바꾸는 것: 천 단위 쉼표(113520원 → 113,520원), 불필요한 ".0",
 * 템플릿의 "이(가)"와 합니다체를 화면 말투(해요체)로, 운영 첫 줄을 저장된 추천 안 기준으로,
 * 요약에 바꿔 넘긴 안 이름("직원 추가")을 화면 이름("한 명 추가")으로, 경고와 겹치는 주의 문구 정리.
 */
final class ExplanationText {

	private ExplanationText() {
	}

	private static final Pattern BIG_NUMBER = Pattern.compile("(?<![\\d.,])(\\d{4,})(?![\\d,]|\\.\\d)");
	private static final Pattern ZERO_DECIMAL = Pattern.compile("(?<![\\d.])(\\d+)\\.0(?=\\s*(%|분|시간|회))");
	private static final Pattern JOSA = Pattern.compile("(\\S)이\\(가\\)");
	private static final Pattern CHEAPEST = Pattern.compile("으로 가장 쌉니다\\(다음 안보다 (\\S+원) 적음\\)\\.");
	private static final Pattern NOUN_ENDING = Pattern.compile("(\\S)입니다(?=[.!,)]|$)");
	private static final String SIMILAR_TO_WARNING = "실제 매장과 다를 수";
	private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?])\\s+");
	private static final java.util.Set<String> WARNING_WORDS = java.util.Set.of("이", "이번", "이는", "결과는", "결과", "모든",
			"값은", "값이며", "값이라", "값이에요", "가정에", "근거한", "가정", "가정이라", "모의", "조건", "조건이라", "조건에서",
			"조건으로", "조건의", "나온", "계산한", "것이며", "것이라", "실제", "매장과", "다를", "수", "있어요", "있습니다", "있음");
	private static final Pattern SIMULATION_WORDS = Pattern.compile("모의\\s*조건|시뮬레이션");

	@SuppressWarnings("unchecked")
	static Map<String, Object> polish(Map<String, Object> data, String featureType, Map<String, Object> summary) {
		Map<String, Object> out = new LinkedHashMap<>(data);
		if (!(data.get("explanation") instanceof Map<?, ?> raw)) {
			return out;
		}
		Map<String, Object> explanation = new LinkedHashMap<>((Map<String, Object>) raw);
		boolean operation = "operation".equals(featureType);
		explanation.put("headline", operation ? operationHeadline(summary)
				: text(String.valueOf(explanation.getOrDefault("headline", "")), false));
		List<Map<String, Object>> perChoice = new ArrayList<>();
		if (explanation.get("per_choice") instanceof List<?> list) {
			for (Object item : list) {
				if (item instanceof Map<?, ?> row) {
					Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) row);
					copy.put("text", text(String.valueOf(row.get("text")), operation));
					perChoice.add(copy);
				}
			}
		}
		explanation.put("per_choice", perChoice);
		List<String> warningMessages = new ArrayList<>();
		if (explanation.get("warnings_echo") instanceof List<?> warnings) {
			for (Object warning : warnings) {
				if (warning instanceof Map<?, ?> w && w.get("message") instanceof String message) {
					warningMessages.add(message);
				}
			}
		}
		List<String> caveats = new ArrayList<>();
		if (explanation.get("caveats") instanceof List<?> list) {
			for (Object item : list) {
				if (!(item instanceof String caveat)) {
					continue;
				}
				// 주의 하나에 여러 문장이 있을 수 있어, 겹치거나 맞지 않는 문장만 빼고 나머지 정보는 남긴다.
				List<String> kept = new ArrayList<>();
				for (String sentence : SENTENCE_END.split(text(caveat, operation).trim())) {
					boolean repeatsWarning = sentence.contains(SIMILAR_TO_WARNING) && onlyRepeatsWarning(sentence)
							&& warningMessages.stream().anyMatch(m -> m.contains(SIMILAR_TO_WARNING));
					// 매입은 시뮬레이션이 아니라 견적으로 푼 최적화다. 모의 조건·시뮬레이션이 들어간 문장은 통째로 뺀다.
					// AI 서버가 먼저 걸러 내고, 여기서는 한 번 더 막는다. 문장을 쪼개 고쳐 쓰지는 않는다.
					boolean wrongForPurchase = !operation && SIMULATION_WORDS.matcher(sentence).find();
					if (!sentence.isBlank() && !repeatsWarning && !wrongForPurchase) {
						kept.add(sentence.trim());
					}
				}
				String polished = String.join(" ", kept);
				if (!polished.isEmpty() && !caveats.contains(polished)) {
					caveats.add(polished);
				}
			}
		}
		explanation.put("caveats", caveats);
		out.put("explanation", explanation);
		return out;
	}

	static String text(String value, boolean operation) {
		String text = value;
		if (operation) {
			text = text.replace(ExplanationSummary.OPERATION_LABELS.get("ALT_C"), "한 명 추가");
		}
		text = CHEAPEST.matcher(text).replaceAll("으로 가장 싸요. 다음 안보다 $1 적어요.");
		text = politeEnding(text);
		text = josa(text);
		text = ZERO_DECIMAL.matcher(text).replaceAll("$1");
		Matcher number = BIG_NUMBER.matcher(text);
		StringBuilder grouped = new StringBuilder();
		while (number.find()) {
			number.appendReplacement(grouped, String.format("%,d", Long.parseLong(number.group(1))));
		}
		number.appendTail(grouped);
		return grouped.toString();
	}

	/**
	 * 문장이 모의 조건 경고와 같은 말만 하는지. 경고에 쓰이는 낱말(모의·조건·가정·실제 매장과 다를 수…) 밖의
	 * 낱말이 하나라도 있으면(예: "휴게 시간은 반영하지 않았어요") 새 정보로 보고 남긴다.
	 */
	static boolean onlyRepeatsWarning(String sentence) {
		for (String word : sentence.replaceAll("[.,!?:;()]", " ").trim().split("\\s+")) {
			if (!word.isEmpty() && !WARNING_WORDS.contains(word)) {
				return false;
			}
		}
		return true;
	}

	/** 화면은 해요체다. 설명에 자주 나오는 합니다체 끝맺음만 바꾸고, 문장 내용은 건드리지 않는다. */
	static String politeEnding(String text) {
		String out = text;
		String[][] endings = {
				{"되었습니다", "됐어요"}, {"였습니다", "였어요"}, {"었습니다", "었어요"}, {"았습니다", "았어요"},
				{"했습니다", "했어요"}, {"같습니다", "같아요"}, {"있습니다", "있어요"}, {"없습니다", "없어요"},
				{"않습니다", "않아요"}, {"됩니다", "돼요"}, {"합니다", "해요"}};
		for (String[] ending : endings) {
			out = out.replaceAll(ending[0] + "(?=[.!,)]|$)", ending[1]);
		}
		Matcher noun = NOUN_ENDING.matcher(out);
		StringBuilder polite = new StringBuilder();
		while (noun.find()) {
			String last = noun.group(1);
			noun.appendReplacement(polite, Matcher.quoteReplacement(last + (hasBatchim(last) ? "이에요" : "예요")));
		}
		noun.appendTail(polite);
		return polite.toString();
	}

	/** 저장된 추천 안으로 운영 첫 줄을 만든다. 템플릿 첫 줄은 금액만 비교해 운영에는 맞지 않는다. */
	static String operationHeadline(Map<String, Object> summary) {
		Object key = summary.get("recommended_choice_key");
		if (key == null) {
			return "모의 조건으로 세 안을 비교했어요. 기준을 지키는 안이 없어 추천한 안은 없어요.";
		}
		String label = "ALT_C".equals(key) ? "한 명 추가"
				: ExplanationSummary.OPERATION_LABELS.getOrDefault(String.valueOf(key), String.valueOf(key));
		return "모의 조건으로 세 안을 비교했어요. 추천한 안은 " + label + (hasBatchim(label) ? "이에요." : "예요.");
	}

	private static String josa(String text) {
		Matcher matcher = JOSA.matcher(text);
		StringBuilder out = new StringBuilder();
		while (matcher.find()) {
			String last = matcher.group(1);
			matcher.appendReplacement(out, Matcher.quoteReplacement(last + (hasBatchim(last) ? "이" : "가")));
		}
		matcher.appendTail(out);
		return out.toString();
	}

	/** 한글 음절의 받침 여부. 한글이 아니면 받침이 없다고 본다. */
	static boolean hasBatchim(String word) {
		if (word.isEmpty()) {
			return false;
		}
		char last = word.charAt(word.length() - 1);
		return last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 != 0;
	}
}
