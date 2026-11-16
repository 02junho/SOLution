package com.solution.common.demo;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;

/**
 * 시연용 기본 데이터(매장 1곳, 구매 업무 3건)를 서버가 뜰 때 넣는다. DEMO_SEED=true일 때만 돈다.
 *
 * <p>입력 확인·대화 API가 아직 없어도 Swagger(/docs)나 화면에서 구매안 계산 실행·상세 조회를 바로 해 볼 수 있게 한다.
 * 이미 있는 행은 건너뛰므로 여러 번 떠도 같다. 내용은 db/demo/demo_seed.sql.
 */
@Component
@ConditionalOnProperty(name = "demo.seed", havingValue = "true")
public class DemoSeedRunner implements ApplicationRunner {

	static final String SEED_FILE = "db/demo/demo_seed.sql";
	private static final Logger log = LoggerFactory.getLogger(DemoSeedRunner.class);

	private final DataSource dataSource;

	public DemoSeedRunner(DataSource dataSource) {
		this.dataSource = dataSource;
	}

	@Override
	public void run(ApplicationArguments args) {
		new ResourceDatabasePopulator(new ClassPathResource(SEED_FILE)).execute(dataSource);
		log.info("시연용 기본 데이터 확인 완료 ({}): 매장 1, 구매 업무 1001·1002·1003", SEED_FILE);
	}
}
