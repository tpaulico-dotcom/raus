from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
from pathlib import Path


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Cache local (SQLite) : zéro clé payante, zéro serveur externe
from lib import cache
from routers.tiles import CACHE_VERSION, router as tiles_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    cache.init()
    yield


app = FastAPI(title="RAUS", lifespan=lifespan)
api_router = APIRouter(prefix="/api")


@api_router.get("/")
async def root():
    return {"message": "RAUS Live Model", "tile_version": CACHE_VERSION}

@api_router.get("/cache")
async def cache_stats():
    return cache.stats()

api_router.include_router(tiles_router)

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
