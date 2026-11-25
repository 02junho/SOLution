package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class SessionPrivacyTest {

	@ParameterizedTest
	@CsvSource(delimiter = '|', value = {
			"010-1234-5678|[전화번호]",
			"02 123 4567|[전화번호]",
			// 국가번호(+82)가 붙은 형식. 앞자리 0은 붙여도 빼도 가린다.
			"+82 10-1234-5678|[전화번호]",
			"+82-10-1234-5678|[전화번호]",
			"+821012345678|[전화번호]",
			"+82 2-123-4567|[전화번호]",
			"+82 010-1234-5678|[전화번호]",
			// 긴 숫자와 + 없는 82 숫자는 금액·수량일 수 있어 그대로 둔다.
			"901012345678|901012345678",
			"821012345678|821012345678",
			// 전화번호 모양이 앞에 붙은 이메일은 주소 전체를 이메일로 가린다.
			"+821012345678@example.com|[이메일]",
			"01012345678@example.com|[이메일]",
			"+82 10-1234-5678 a@b.com|[전화번호] [이메일]",
	})
	void 국내와_국가번호_형식의_전화번호를_가리고_긴_숫자는_그대로_둔다(String text, String expected) {
		assertThat(SessionPrivacy.maskPii(text)).isEqualTo(expected);
	}
}
