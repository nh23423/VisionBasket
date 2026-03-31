import os 
from dotenv import load_dotenv

load_dotenv()

class Config:
    WEIGHTS_PATH = os.getenv("WEIGHTS_PATH", "./weights/checkpoint_best_total.pth")
    REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    S3_KEY = os.environ.get("AWS_ACCESS_KEY", "minioadmin")
    S3_SECRET = os.environ.get("AWS_SECRET_KEY", "minioadmin")
    S3_ENDPOINT = os.environ.get("S3_ENDPOINT_URL", None)
    S3_PUBLIC_URL = os.environ.get("S3_PUBLIC_URL", None)
    S3_REGION = os.environ.get("AWS_REGION", None)
    BUCKET_NAME = os.environ.get("BUCKET_NAME", None)
