import os
import base64
import cv2
import json
import asyncio
from fastapi import FastAPI, Depends, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from uuid import uuid4
import redis.asyncio as aioredis
from pathlib import Path
from celery_worker import execute_tracking_pipeline, execute_corrections_task
from upload import UploadVideo
from config import Config
from models import StartUploadRequest, StartUploadResponse, CompleteUploadRequest, CompleteUploadResponse, AnalyseRequest, BatchCorrectionRequest
from database.connect import init_db, async_engine
from contextlib import asynccontextmanager

REDIS_URL = Config.REDIS_URL
DEST = [
    # [ 92, 1014], # bottom-left corner
    # [ 92, 92], # top-left corner
    # [ 92, 553], # baseline center (L)
    # [ 443, 701], # paint bottom-left (L)
    # [ 443, 405], # paint bottom-right (L)
    # [ 92, 405], # paint top-right (L)
    # [ 92, 701], # paint top-left (L)
    # [ 960, 1014], # bottom mid-court
    # [ 960, 92], # top mid-court
    # [ 960, 553], # center

    [1827, 92], # top-right corner
    [1827, 405], # paint top-right (R)
    [1827, 553], # baseline center (R)
    [1827, 701], # paint top-left (R)
    [1827, 1014], # bottom-right corner
    [1476, 405], # paint bottom-right (R)
    [1476, 701], # paint bottom-left (R)
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.s3_uploader = UploadVideo()
    
    # We only CHECK if it exists. We do NOT try to create it.
    try:
        app.state.s3_uploader.s3.head_bucket(Bucket=Config.BUCKET_NAME)
        print(f"--- S3 Connection Verified: {Config.BUCKET_NAME} is ready ---")
    except Exception as e:
        print(f"--- S3 WARNING: Could not verify bucket {Config.BUCKET_NAME} ---")
        print(f"Error: {str(e)}")
        # We don't crash the app here, just in case it's a permission quirk.
        
    await init_db()
    yield
    await async_engine.dispose()

def get_s3_uploader(request: Request) -> UploadVideo:
    return request.app.state.s3_uploader

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, 
    allow_origins=["*"], 
    allow_credentials=True, 
    allow_methods=["*"], 
    allow_headers=["*"]
)

def extract_setup_frame(input_path:str):
    cap = cv2.VideoCapture(input_path)
    ret, frame = cap.read()
    cap.release()
    _, buffer = cv2.imencode('.jpg', frame)
    return f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

@app.post("/start-upload")
async def start_multipart_upload(req: StartUploadRequest, uploader: UploadVideo = Depends(get_s3_uploader)) -> StartUploadResponse:
    s3_key = f"{str(uuid4())}.mp4"
    return uploader.get_presigned_urls(
        key=s3_key, 
        content_type=req.content_type, 
        file_size=req.file_size
    )

@app.post("/complete-upload")
async def complete_upload(req: CompleteUploadRequest, uploader: UploadVideo = Depends(get_s3_uploader)) -> CompleteUploadResponse:
    result = uploader.complete_multipart_upload(req.key, req.upload_id, req.etags)
    presigned_url = uploader.s3.generate_presigned_url(
        'get_object', 
        Params={'Bucket': Config.BUCKET_NAME, 
                'Key': req.key}, 
        ExpiresIn=3600
    )
    return CompleteUploadResponse(
        url=result.get("Location"), 
        task_id=req.key.replace('.mp4', ''), 
        frame=extract_setup_frame(presigned_url), 
        setup_pts=DEST
    )

@app.post("/analyse")
async def analyse_video(request: AnalyseRequest):
    execute_tracking_pipeline.delay(request.task_id, request.points)
    return {"task_id": request.task_id}

@app.post("/correction")
async def correct_video(requests: BatchCorrectionRequest):
    # Convert Pydantic models to dicts for Celery serialization
    corrections_dict = [c.model_dump() for c in requests.corrections]
    # Fire task to Celery 
    execute_corrections_task.delay(requests.task_id, requests.points, corrections_dict)
    return {"status": "Correction Processing", "task_id": requests.task_id}

@app.websocket("/ws/{task_id}")
async def get_status(websocket: WebSocket, task_id: str):
    # Redis is alerted of any pushes form the celery worker. 
    # The change is then sent down the websockets channel
    await websocket.accept()
    redis_conn = aioredis.from_url(REDIS_URL)
    pubsub = redis_conn.pubsub()
    await pubsub.subscribe(f"ws_{task_id}")
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                load = json.loads(message["data"])
                await websocket.send_json(load)
                if load["status"] in ("completed", "failed"):
                    break
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(f"ws_{task_id}")
        await pubsub.close()
