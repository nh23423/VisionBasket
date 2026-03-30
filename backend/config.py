import os 

class Config:
    WEIGHTS_PATH = os.getenv("MODEL_WEIGHTS_PATH", "weights/checkpoint_best_total.pth")
    REDIS_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
    S3_KEY = os.environ.get("AWS_ACCESS_KEY", "minioadmin")
    S3_SECRET = os.environ.get("AWS_SECRET_KEY", "minioadmin")
    S3_ENDPOINT = os.environ.get("S3_ENDPOINT_URL", "http://minio:9000")
    S3_PUBLIC_URL = os.environ.get("S3_PUBLIC_URL", "http://localhost:9000")
    S3_REGION = os.environ.get("AWS_REGION", "eu-west-2")
    BUCKET_NAME = os.environ.get("S3_BUCKET_NAME", "my-videos")