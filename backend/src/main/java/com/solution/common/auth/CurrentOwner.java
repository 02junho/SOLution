package com.solution.common.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 지금 요청한 사장님의 식별값(store.owner_key와 비교).
 *
 * <p>시연은 로그인 없이 고정 사용자 하나로 한다 (URQ-BAS-009 비고). 값은 DEMO_OWNER_KEY 환경 변수,
 * 없으면 "demo-owner". 로그인을 붙이면 이 클래스만 바꾸면 된다.
 */
@Component
public class CurrentOwner {

	private final String demoOwnerKey;

	public CurrentOwner(@Value("${demo.owner-key:demo-owner}") String demoOwnerKey) {
		this.demoOwnerKey = demoOwnerKey;
	}

	public String key() {
		return demoOwnerKey;
	}
}
