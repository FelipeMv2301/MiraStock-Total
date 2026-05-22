import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler

load_dotenv()

from app.catalog_router import router as catalog_router
from app.sap_sync_worker import start_async_sync
from app.database import init_db

SYNC_INTERVAL_MINUTES = int(os.getenv("SYNC_INTERVAL_MINUTES", "60"))

scheduler = BackgroundScheduler(timezone="America/Santiago")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler.add_job(
        start_async_sync,
        trigger="interval",
        minutes=SYNC_INTERVAL_MINUTES,
        id="auto_sync",
        replace_existing=True,
    )
    scheduler.start()
    print(f"[OK] MiraStock-Total iniciado. Sync automático cada {SYNC_INTERVAL_MINUTES} minutos.")
    yield
    scheduler.shutdown(wait=False)
    print("[OK] Scheduler detenido.")


app = FastAPI(title="MiraStock-Total", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(catalog_router)

static_path = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=static_path, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    print("Iniciando MiraStock-Total en la red local...")
    uvicorn.run(app, host="0.0.0.0", port=8001)
