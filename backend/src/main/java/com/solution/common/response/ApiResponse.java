package com.solution.common.response;

/**
 * 모든 API 공통 응답 형식: { "status": "ok", "data": {...}, "message": "..." }
 *
 * <p>needs_input·infeasible은 정상 응답(HTTP 200)으로 status에 담고, 시스템 오류만 HTTP 5xx + error로 보낸다.
 */
public record ApiResponse<T>(ResponseStatus status, T data, String message) {

	public static <T> ApiResponse<T> ok(T data) {
		return new ApiResponse<>(ResponseStatus.OK, data, null);
	}

	public static <T> ApiResponse<T> needsInput(T data, String message) {
		return new ApiResponse<>(ResponseStatus.NEEDS_INPUT, data, message);
	}

	public static <T> ApiResponse<T> infeasible(T data, String message) {
		return new ApiResponse<>(ResponseStatus.INFEASIBLE, data, message);
	}

	public static <T> ApiResponse<T> error(String message) {
		return new ApiResponse<>(ResponseStatus.ERROR, null, message);
	}
}
