package com.solution.common.id;

import java.util.concurrent.atomic.AtomicLong;

import org.springframework.stereotype.Component;

/**
 * DB에 자동 번호가 없어서(ERD: PK는 서버가 생성) 서버가 PK를 만든다.
 *
 * <p>현재 시각(ms) × 1000 + 순번. 서버 한 대 기준으로 겹치지 않고 시간 순으로 커진다.
 * 서버를 여러 대 띄우게 되면 다른 방식으로 바꿔야 한다.
 */
@Component
public class IdGenerator {

	private final AtomicLong last = new AtomicLong();

	public long next() {
		return last.updateAndGet(previous -> Math.max(previous + 1, System.currentTimeMillis() * 1000));
	}
}
