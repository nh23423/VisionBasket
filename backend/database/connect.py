from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker,Session
from database.table import Base
import os

DB_HOST = os.getenv("POSTGRES_HOST", "127.0.0.1")
DB_PORT = os.getenv("POSTGRES_PORT", "5435")

ASYNC_DATABASE_URL = f"postgresql+asyncpg://tracker:tracker_pass@{DB_HOST}:{DB_PORT}/tracking"
SYNC_DATABASE_URL  = f"postgresql://tracker:tracker_pass@{DB_HOST}:{DB_PORT}/tracking"

async_engine = create_async_engine(
    ASYNC_DATABASE_URL,
    echo=False,
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

sync_engine = create_engine(
    SYNC_DATABASE_URL,
    echo=False,
    pool_size=5,
    max_overflow=10,
)

SyncSessionLocal = sessionmaker(
    bind=sync_engine,
    autocommit=False,
    autoflush=False,
    class_=Session,
)

async def init_db():
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
        
def get_sync_db():
    with SyncSessionLocal() as session:
        yield session