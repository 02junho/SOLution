from functools import lru_cache
from pathlib import Path

from psycopg.conninfo import make_conninfo
from pydantic_settings import BaseSettings, SettingsConfigDict

# 로컬 실행은 저장소 루트의 .env를 읽고, docker compose 실행은 compose가 넣어 주는 환경 변수를 쓴다.
REPO_ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT_ENV, extra="ignore")

    # LLM
    anthropic_api_key: str = ""
    # 모델은 한 곳에서만 정한다 (11.12 결정: Claude Sonnet 5.5). 평가 결과를 다시 낼 수 있게 날짜 없는 ID를 고정해서 쓴다.
    anthropic_model: str = "claude-sonnet-5-5"

    # DB
    db_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "solution"
    postgres_user: str = "solution"
    postgres_password: str = ""

    @property
    def database_conninfo(self) -> str:
        return make_conninfo(
            host=self.db_host,
            port=self.postgres_port,
            dbname=self.postgres_db,
            user=self.postgres_user,
            password=self.postgres_password,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
