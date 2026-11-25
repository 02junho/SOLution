package com.solution.operation.service;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

class StaffingContractTest {
	@Test void validatesSharedStaffingAndClosingBoundaries() {
		assertThat(StaffingContractCheck.runChecks()).isGreaterThanOrEqualTo(29);
	}
}
