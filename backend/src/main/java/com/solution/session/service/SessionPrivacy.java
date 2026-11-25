package com.solution.session.service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** events와 확정 스냅샷이 공유하는 개인정보 가림 규칙. 숫자 값은 그대로 보존한다. */
final class SessionPrivacy {

	private static final Pattern PHONE = Pattern.compile("(?<!\\d)(?:\\+82[-\\s]?0?(?:1[016-9]|2|[3-6][1-5])|01[016-9]|02|0[3-6][1-5])[-\\s]?\\d{3,4}[-\\s]?\\d{4}(?!\\d)");
	private static final Pattern EMAIL = Pattern.compile("[\\w.+-]+@[\\w-]+\\.[\\w.-]+");
	private static final Pattern NAMED_PERSON = Pattern.compile("((?:담당자|성함|이름)\\s*[:：=]?\\s*)[가-힣]{2,4}");

	private static final Set<String> PRIVATE_FIELDS = Set.of("phone", "phone_number", "email", "person_name",
			"contact_name", "customer_name", "owner_name", "전화번호", "이메일", "담당자", "성함");

	static boolean isPrivateField(String name) {
		return PRIVATE_FIELDS.contains(name.toLowerCase(Locale.ROOT));
	}

	private SessionPrivacy() {
	}

	static String maskPii(String text) {
		// 이메일을 먼저 가린다. 전화번호 모양의 앞부분(+821012345678@...)을 먼저 바꾸면 도메인이 남는다.
		return NAMED_PERSON.matcher(PHONE.matcher(EMAIL.matcher(text).replaceAll("[이메일]"))
				.replaceAll("[전화번호]")).replaceAll("$1[이름]");
	}

	static Object maskSnapshot(Object value) {
		if (value instanceof String text) { return maskPii(text); }
		if (value instanceof List<?> list) { return list.stream().map(SessionPrivacy::maskSnapshot).toList(); }
		if (value instanceof Map<?, ?> map) {
			Map<String, Object> result = new LinkedHashMap<>();
			map.forEach((key, item) -> {
				String name = String.valueOf(key);
				String maskedKey = maskPii(name);
				if (result.containsKey(maskedKey)) {
					throw new ResultConfirmException("RESULT_NOT_READY", "개인정보를 가린 선택안 정보를 확인할 수 없습니다.");
				}
				result.put(maskedKey, isPrivateField(name) && item != null ? "[개인정보]" : maskSnapshot(item));
			});
			return result;
		}
		return value;
	}
}
