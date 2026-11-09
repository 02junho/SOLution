from fastapi import FastAPI

app = FastAPI(title="SOLution AI Server")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
