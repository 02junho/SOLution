package com.solution.session.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;

import com.solution.session.service.WorkResultConfirmService;

@WebMvcTest(WorkResultController.class)
@ExtendWith(OutputCaptureExtension.class)
class WorkResultControllerTest {

	@Autowired private MockMvc mvc;
	@Autowired private WorkResultController controller;
	@MockitoBean private WorkResultConfirmService service;

	@Test
	void 지원하지_않는_ContentType은_500_대신_415이고_서버실패_로그가_없다(CapturedOutput output) throws Exception {
		mvc.perform(post("/api/v1/work-results/2001/confirm").contentType(MediaType.TEXT_PLAIN).content("{}"))
				.andExpect(status().isUnsupportedMediaType())
				.andExpect(jsonPath("$.data.detail_code").value("INVALID_REQUEST"));
		assertThat(output.getAll()).doesNotContain("확정 저장 실패");
	}

	@Test
	void 클라이언트_ErrorResponse의_상태를_유지하고_이유를_노출하지_않는다(CapturedOutput output) {
		var response = controller.handleUnexpected(new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "private-client-reason"));
		assertThat(response.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
		assertThat(response.getBody().data()).containsEntry("detail_code", "INVALID_REQUEST");
		assertThat(response.getBody().message()).isEqualTo("요청 값의 형식을 확인해 주세요.");
		assertThat(output.getAll()).doesNotContain("확정 저장 실패", "private-client-reason");
	}

	@Test
	void 서버_ErrorResponse도_상태를_유지하고_일반_오류문구를_반환한다(CapturedOutput output) {
		var response = controller.handleUnexpected(new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "private-server-reason"));
		assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
		assertThat(response.getBody().data()).containsEntry("detail_code", "INTERNAL_ERROR");
		assertThat(response.getBody().message()).isEqualTo("저장 중 오류가 발생했습니다.");
		assertThat(output.getAll()).contains("확정 저장 실패", ResponseStatusException.class.getName())
				.doesNotContain("private-server-reason");
	}

	@Test
	void 일반_예외는_500이고_메시지_없이_최상위와_근본원인_클래스만_로그에_남긴다(CapturedOutput output) {
		var exception = new IllegalStateException("private-wrapper-message",
				new IllegalArgumentException("private-root-message"));
		var response = controller.handleUnexpected(exception);
		assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
		assertThat(response.getBody().data()).containsEntry("detail_code", "INTERNAL_ERROR");
		assertThat(response.getBody().message()).isEqualTo("저장 중 오류가 발생했습니다.");
		assertThat(output.getAll()).contains(IllegalStateException.class.getName(), IllegalArgumentException.class.getName())
				.doesNotContain("private-wrapper-message", "private-root-message", "Caused by:");
	}
}
