package com.solution.common.client;

/** FastAPI 서버에 연결하지 못했거나 시스템 오류(error)를 돌려받았을 때 */
public class AiServerException extends RuntimeException {

	public AiServerException(String message) {
		super(message);
	}

	public AiServerException(String message, Throwable cause) {
		super(message, cause);
	}
}
