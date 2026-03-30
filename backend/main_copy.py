import shutil
import os
import boto3
import cv2
import numpy as np
import torch
import asyncio
from fastapi import FastAPI, Depends, Request, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from celery_worker import insert_detections,rep_detections
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from uuid import uuid4
from helper import iou_box,is_fully_inframe, get_crop_frame_coords
import uvicorn
import base64
from track import ObjectTracker
from boxmot import BotSort
from rfdetr import RFDETRMedium
from common import TrackState
from reid import ReIDPredictor
from typing import List, Dict
from models import StartUploadRequest, StartUploadResponse, CompleteUploadRequest, CompleteUploadResponse, AnalyseRequest, BatchCorrectionRequest
from database.connect import init_db, AsyncSessionLocal,async_engine, get_db, SyncSessionLocal
from database import crud_async,crud_sync
from contextlib import asynccontextmanager
from collections import defaultdict
from upload import UploadVideo
from config import Config
import traceback

import logging
logger = logging.getLogger("uvicorn.error")

S3_KEY = os.environ.get("AWS_ACCESS_KEY", "minioadmin")
S3_SECRET = os.environ.get("AWS_SECRET_KEY", "minioadmin")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT_URL", "http://localhost:9000")
S3_REGION = os.environ.get("AWS_REGION", "eu-west-2")
BUCKET_NAME = os.environ.get("S3_BUCKET_NAME", "my-videos")

# The Scratch Space
TEMP_DISK_FOLDER = Path("/tmp/video_scratch")
TEMP_DISK_FOLDER.mkdir(parents=True, exist_ok=True)

# Initialize shared buffer, upgraded to redis for the future
task_queues: Dict[str, asyncio.Queue] = {}

@asynccontextmanager
async def lifespan(app: FastAPI):

    app.state.s3_uploader = UploadVideo()
    
    try:
        app.state.s3_uploader.s3.head_bucket(Bucket=Config.BUCKET_NAME)
    except:
        app.state.s3_uploader.s3.create_bucket(Bucket=Config.BUCKET_NAME)
        
    await init_db()
    yield
    print("Shutting down database and S3 connections")
    await async_engine.dispose()

def get_s3_uploader(request: Request) -> UploadVideo:
    return request.app.state.s3_uploader

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIDENCE_THRESHOLD = 0.5
STATE_COLORS = {
    TrackState.SAFE: (0, 255, 0),
    TrackState.RISK: (0, 255, 255),
    TrackState.OCCLUDED: (0, 0, 255)
}

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

# Model Initialisation
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'mps')
if DEVICE.type == 'cuda':
    torch.autocast(device_type="cuda", dtype=torch.float16).__enter__()

print("Initializing Models...")
RFDETR_CHECKPOINT = "weights/checkpoint_best_total.pth"
model = RFDETRMedium(pretrain_weights=RFDETR_CHECKPOINT)
try:
    model.optimize_for_inference()
except AttributeError:
    pass

reid_model = ReIDPredictor(DEVICE)
print("Models Ready.")

def extract_setup_frame(input_path:str):
    cap = cv2.VideoCapture(input_path)
    ret, frame = cap.read()
    cap.release()

    _, buffer = cv2.imencode('.jpg', frame)
    base64_frame = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{base64_frame}"

def homography(pts,dst):
    src_pts = np.array(pts, dtype=np.float32)
    dst_pts = np.array(dst, dtype=np.float32)
    H, _ = cv2.findHomography(src_pts,dst_pts,cv2.RANSAC,5.0)
    return H

def object_detection(frame,relevant_ids):
    result = model.predict(frame, threshold=CONFIDENCE_THRESHOLD)
    mask = np.isin(result.class_id, relevant_ids)
    detections = result[mask]
    if len(detections) > 0:
        dets_to_sort = np.hstack([
            detections.xyxy,
            detections.confidence.reshape(-1, 1),
            detections.class_id.reshape(-1, 1)
        ])
    else:
        dets_to_sort = np.empty((0, 6))
    return dets_to_sort

def reid_score_match(active_tracks,sig1):
    highest_score = 0.7
    bmid = None

    for idn, tr in list(active_tracks.items()): #compare against the unmodified dictionary
        if tr.dis_cont and idn != id:

            if tr.cache_frame:
                sub_frame2 = [i[0] for i in tr.cache_frame]
            elif tr.risk_frame:
                sub_frame2 = [tr.risk_frame[0]]
            else:
                continue

            sub_score = 0
            for f in sub_frame2:
                sig2 = reid_model.get_signature(f)
                is_similar, score = reid_model.similarity_check(sig1, sig2)
                sub_score = max(score,sub_score)

            if sub_score > highest_score:
                highest_score = sub_score
                bmid = idn
    return highest_score,bmid

def track_processing(tracks,id_mapping,active_tracks,width,height,idx,frame):
    frame_tracks = []
    for t in tracks:
        raw_id = int(t[4])
        if raw_id in id_mapping:
            id = id_mapping[raw_id]
        else:
            id = raw_id

        bbox = t[:4]
        conf = t[5]
        class_id = int(t[6])

        if id not in active_tracks and conf > 0.65 and is_fully_inframe(bbox, width, height):

            new_track = ObjectTracker(id, bbox, conf, idx, class_id)
            x1, y1, x2, y2 = get_crop_frame_coords(bbox, width, height)

            sub_frame = frame[y1:y2, x1:x2].copy()
            sig1 = reid_model.get_signature(sub_frame)

            # Compare against Discontinued tracks
            highest_score,best_match_id = reid_score_match(active_tracks,sig1)

            if best_match_id is not None:
                id_mapping[raw_id] = best_match_id
                active_tracks[best_match_id].bbox = new_track.bbox
                active_tracks[best_match_id].confidence = new_track.confidence
                active_tracks[best_match_id].dis_cont = False
                active_tracks[best_match_id].class_id = class_id

                if id in active_tracks and id != best_match_id:
                    del active_tracks[id]

                frame_tracks.append(best_match_id)
                continue
            else:
                active_tracks[id] = new_track
                frame_tracks.append(id)

        elif id in active_tracks:
            frame_tracks.append(id)
            active_tracks[id].bbox = bbox
            active_tracks[id].dis_cont = False
            active_tracks[id].confidence = conf
            active_tracks[id].class_id = class_id

    return active_tracks,frame_tracks

def find_switch_point(track_data1: dict, track_data2: dict, width: int, height: int, frames: dict):
    frame_indices = sorted(list(set(track_data1.keys()) & set(track_data2.keys())))
    
    # Check if they're in the same frame 
    if not frame_indices:
        return None
        
    if len(frame_indices) <= 2:
        return frame_indices[-1]

    # Distance between bounding box centres
    min_dist_sq = float('inf')
    closest_frame = frame_indices[0]
    
    for i in frame_indices:
        box1, box2 = track_data1[i], track_data2[i]
        
        # Calculate center coordinates (cx, cy) of both boxes
        cx1, cy1 = (box1[0] + box1[2]) / 2.0, (box1[1] + box1[3]) / 2.0
        cx2, cy2 = (box2[0] + box2[2]) / 2.0, (box2[1] + box2[3]) / 2.0
        
        # Calculate squared Euclidean distance (faster than using math.sqrt)
        dist_sq = (cx1 - cx2)**2 + (cy1 - cy2)**2
        
        if dist_sq < min_dist_sq:
            min_dist_sq = dist_sq
            closest_frame = i

    # Check appearance deviation
    anchor = frame_indices[0]
    
    l1, t1, r1, b1 = get_crop_frame_coords(track_data1[anchor], width, height)
    anchor1 = reid_model.get_signature(frames[anchor][t1:b1, l1:r1].copy())
    
    l2, t2, r2, b2 = get_crop_frame_coords(track_data2[anchor], width, height)
    anchor2 = reid_model.get_signature(frames[anchor][t2:b2, l2:r2].copy())
    
    consecutive_swaps = 0 
    
    # --- STAGE 3: Combined Fusion Logic ---
    for i in frame_indices[1:]:
        box1, box2 = track_data1[i], track_data2[i]
        
        l1, t1, r1, b1 = get_crop_frame_coords(box1, width, height)
        l2, t2, r2, b2 = get_crop_frame_coords(box2, width, height)
        
        crop1 = frames[i][t1:b1, l1:r1].copy()
        crop2 = frames[i][t2:b2, l2:r2].copy()
        
        sig1 = reid_model.get_signature(crop1)
        sig2 = reid_model.get_signature(crop2)

        # Relative Appearance Check
        _, score1_to_1 = reid_model.similarity_check(sig1, anchor1)
        _, score1_to_2 = reid_model.similarity_check(sig1, anchor2)
        _, score2_to_2 = reid_model.similarity_check(sig2, anchor2)
        _, score2_to_1 = reid_model.similarity_check(sig2, anchor1)
        
        if score1_to_2 > score1_to_1 and score2_to_1 > score2_to_2:
            consecutive_swaps += 1
            if consecutive_swaps >= 2:
                # Checks if the swap happens when the 2 bounding boxes are close to each other. 
                if i >= closest_frame - 3: 
                    return i - 1 
        else:
            consecutive_swaps = 0
            
    # Closest distance Fallback
    return closest_frame + 1
            
def assign_state(t1,active_tracks,id1, frame, width,height,idx):
    max_iou = 0.0
    for id2, t2 in active_tracks.items():
        if t2.dis_cont or id2 == id1:
            continue
        max_iou = max(max_iou, iou_box(t1.bbox, t2.bbox))

    if max_iou > 0.8:
        t1.track_state = TrackState.OCCLUDED
    elif max_iou > 0.2:
        t1.track_state = TrackState.RISK
        if t1.confidence > 0.5:
            t1.update_cache(t1.bbox, frame, idx, t1.confidence)
    else:
        t1.track_state = TrackState.SAFE
        if t1.confidence > 0.8 and is_fully_inframe(t1.bbox, width, height):
            t1.update_cache(t1.bbox, frame, idx, t1.confidence)

# Video processor

def execute_tracking_pipeline(task_id: str, H: np.ndarray, loop: asyncio.AbstractEventLoop, uploader: UploadVideo, is_correction: bool = False, 
                              global_deleted_ids: set = set(), range_corrections: List = []):
    
    s3_key = task_id if task_id.endswith('.mp4') else f"{task_id}.mp4"
    local_input_path = str(TEMP_DISK_FOLDER / s3_key)
    
    try:
        logger.info(f"Downloading {s3_key} to scratch space...")
        uploader.download_file(BUCKET_NAME, s3_key, local_input_path)
        
        tracker = BotSort(reid_weights=None, device=DEVICE, half=True, with_reid=False)
        cap = cv2.VideoCapture(local_input_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) 
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        loop.call_soon_threadsafe(task_queues[task_id].put_nowait, {"status": "started", "fps": fps})
        active_tracks, id_mapping, idx, batch = {}, {}, 0, []
        temp_ws = []
        
        # Used to store all tracks after the correction step below 
        processed_buffer = defaultdict(list)
        
        if is_correction:
                    
            with SyncSessionLocal() as db:
            
                for f in range(1, total_frames + 1):
                    db_frame_result = crud_sync.get_detection_by_frame(db, task_id, f)
                    for det in db_frame_result.detections:
                        track_id = det["track_id"]
                        
                        # Ignore the tracks that were deleted by the user
                        if global_deleted_ids and track_id in global_deleted_ids:
                            continue
                            
                        processed_buffer[f].append({
                            "track_id": track_id, 
                            "x1": det["x1"], "y1": det["y1"], "x2": det["x2"], "y2": det["y2"],
                            "conf": det.get("conf", 1.0), 
                            "class_id": det.get("class_id", 0)
                        })
            
            #ID switch fix logic 
            
            if range_corrections:
                for rc in range_corrections:
                    start, end = rc.start_frame, rc.end_frame
                    id_1 = int(rc.start_state[0].track_id)
                    id_2 = int(rc.start_state[1].track_id)
                    
                    logger.info(f"--- FLIPPING ID {id_1} AND ID {id_2} FROM FRAME ---")
                    track_data1, track_data2, frames = {}, {}, {}
                    cap.set(cv2.CAP_PROP_POS_FRAMES, start - 1)
                    
                    for i in range(start,end+1):
                        ret, frame = cap.read()
                        if not ret: 
                            break
                        frames[i] = frame
                        
                        for d in processed_buffer.get(i,[]):
                            if d["track_id"] == rc.start_state[0].track_id:
                                track_data1[i] = [d["x1"], d["y1"], d["x2"], d["y2"]]
                            elif d["track_id"] == rc.start_state[1].track_id:
                                track_data2[i] = [d["x1"], d["y1"], d["x2"], d["y2"]]
                                
                switched_f = find_switch_point(track_data1, track_data2, width,height, frames) 
                logger.info(f"Switched Frame calculated at: {switched_f}")
                
                if switched_f:
                    for i in range(switched_f,total_frames + 1):
                        for d in processed_buffer.get(i,[]):
                            current_id = int(d["track_id"])
                            
                            if current_id == id_1:
                                d["track_id"] = id_2
                            elif current_id == id_2:
                                d["track_id"] = id_1
                
                # Reset frames back to 0
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret: break
            idx += 1
            
            current_bbox, results, mp = [], [], []
            
            if not is_correction:
                # Standard Pass 1: Detection + Tracking
                dets_to_sort = object_detection(frame, [4, 5, 6, 7, 8, 10])
                tracks = tracker.update(dets_to_sort, frame)
                
                active_tracks, frame_tracks = track_processing(
                    tracks, id_mapping, active_tracks, frame.shape[1], frame.shape[0], idx, frame
                )
                
                for tid in [t for t in active_tracks if t not in frame_tracks]: 
                    active_tracks[tid].dis_cont = True 
                
                for id1, t1 in active_tracks.items():
                    if t1.dis_cont: continue 
                    assign_state(t1, active_tracks, id1, frame, width, height, idx)
                    x1, y1, x2, y2 = map(int, t1.bbox)
                    
                    # Homography
                    input_pt = np.array([[[int((x1+x2)/2), y2]]], dtype=np.float32)
                    tx, ty = cv2.perspectiveTransform(input_pt, H)[0][0]
                    
                    current_bbox.append({
                        "id": int(id1), 
                        "bbox": [int(x1), int(y1), int(x2), int(y2)],
                        "conf": float(t1.confidence), 
                        "class_id": int(t1.class_id)
                    })
                    
                    mp.append([float(tx), float(ty)])
                    results.append({
                        "track_id": int(id1), "x1": float(x1), "y1": float(y1), 
                        "x2": float(x2), "y2": float(y2), "mx": float(tx), 
                        "my": float(ty), "conf": float(t1.confidence), 
                        "class_id": int(t1.class_id)
                    })
            else:
                # Pass 2 (Correction)
                for d in processed_buffer.get(idx, []):
                    x1, y1, x2, y2 = d["x1"], d["y1"], d["x2"], d["y2"]
                    
                    input_pt = np.array([[[int((x1+x2)/2), y2]]], dtype=np.float32)
                    tx, ty = cv2.perspectiveTransform(input_pt, H)[0][0]
                    
                    current_bbox.append({
                        "id": d["track_id"], 
                        "bbox": [x1, y1, x2, y2], 
                        "conf": d["conf"]
                    })
                    
                    mp.append([float(tx), float(ty)])
                    results.append({
                        "track_id": int(d["track_id"]), 
                        "x1": float(x1), "y1": float(y1), 
                        "x2": float(x2), "y2": float(y2), 
                        "mx": float(tx), "my": float(ty), 
                        "conf": float(d["conf"]), 
                        "class_id": int(d["class_id"])
                    })

            # WebSocket Logic
            temp_ws.append({"frame_id": idx, "detections": current_bbox, "mapped_points": mp})
            if len(temp_ws) >= 5 or idx == total_frames:
                loop.call_soon_threadsafe(task_queues[task_id].put_nowait, {
                    "status": "processing", "progress": int((idx/total_frames)*100), "frames": temp_ws
                })
                temp_ws = []
            
            batch.append({"task_id": task_id, "frame_id": idx, "detections": results})
            if len(batch) >= 100:
                with SyncSessionLocal() as db:
                    if is_correction:
                        crud_sync.replace_bulk_frames(db, batch)
                    else:
                        crud_sync.insert_bulk(db, batch)
                batch = []

        cap.release()
        if batch: 
            with SyncSessionLocal() as db:
                if is_correction:
                    crud_sync.replace_bulk_frames(db, batch)
                else:
                    crud_sync.insert_bulk(db, batch)
        loop.call_soon_threadsafe(task_queues[task_id].put_nowait, {"status": "completed", "progress": 100})
    except Exception as e:
        logger.error("!!! TRACKING PIPELINE CRASHED !!!")
        traceback.print_exc()
        if task_id in task_queues:
            loop.call_soon_threadsafe(
                task_queues[task_id].put_nowait, 
                {"status": "failed", "error": str(e)}
            )
    finally:
        if os.path.exists(local_input_path):
            os.remove(local_input_path)
            logger.info(f"Cleaned up scratch space: {local_input_path}")

# @app.post("/upload")
# async def upload_video(video: UploadFile = File(...)):

#     if not video.content_type.startswith("video/"):
#         raise HTTPException(status_code=400, detail="File must be a video.")

#     # Generate ID
#     task_id = str(uuid4())
#     s3_key = f"{task_id}.mp4"
    
#     try:
#         s3_client.upload_fileobj(video.file, BUCKET_NAME, s3_key)
#         print(f"SUCCESSFULLY UPLOADED TO S3: {s3_key}")
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"S3 Upload failed: {e}")
    
#     presigned_url = s3_client.generate_presigned_url(
#         'get_object',
#         Params={'Bucket': BUCKET_NAME, 'Key': s3_key},
#         ExpiresIn=3600
#     )
    
#     frame = extract_setup_frame(presigned_url)
    
#     return {"task_id": task_id, "frame": frame, "setup_pts": DEST}

@app.post("/start-upload")
async def start_multipart_upload(req: StartUploadRequest, uploader: UploadVideo = Depends(get_s3_uploader)) -> StartUploadResponse:
    task_id = str(uuid4())
    s3_key = f"{task_id}.mp4"
    
    return uploader.get_presigned_urls(
        key=s3_key,
        content_type=req.content_type,
        file_size=req.file_size,
    )

@app.post("/complete-upload")
async def complete_upload(req: CompleteUploadRequest, uploader: UploadVideo = Depends(get_s3_uploader)) -> CompleteUploadResponse:
    
    result = uploader.complete_multipart_upload(req.key, req.upload_id, req.etags)
    final_video_url = result.get("Location")
    
    task_id = req.key.replace('.mp4', '')
    
    presigned_url = uploader.s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': Config.BUCKET_NAME, 'Key': req.key},
        ExpiresIn=3600
    )
    
    frame_base64 = extract_setup_frame(presigned_url)
    
    return CompleteUploadResponse(
        url=result.get("Location"),
        task_id=task_id,
        frame=frame_base64,
        setup_pts=DEST
    )
    
@app.post("/correction")
async def correct_video(requests: BatchCorrectionRequest, background_tasks: BackgroundTasks, uploader: UploadVideo = Depends(get_s3_uploader)):
    task_id = requests.task_id
    H = homography(requests.points, DEST)
    task_queues[task_id] = asyncio.Queue()
    
    deleted_ids = set()
    range_corrections = []
    
    for c in requests.corrections:
        
        if c.action == "SWITCH": 
            range_corrections.append(c)
        elif c.action == "DELETE":
            deleted_ids.add(c.track_id)

    background_tasks.add_task(execute_tracking_pipeline, task_id, 
                                H, asyncio.get_event_loop(), uploader, True, deleted_ids, range_corrections)
        
    return {"status": "Correction Processing", "task_id": task_id}

@app.post("/analyse")
async def analyse_video(request: AnalyseRequest, background_tasks: BackgroundTasks, uploader: UploadVideo = Depends(get_s3_uploader)):
    task_id = request.task_id
    H = homography(request.points, DEST)
    task_queues[task_id] = asyncio.Queue()
    background_tasks.add_task(execute_tracking_pipeline, task_id, H, asyncio.get_event_loop(), uploader, False)
    return {"task_id": task_id}

@app.websocket("/ws/{task_id}")
async def get_status(websocket: WebSocket, task_id: str):
    await websocket.accept()
    try:
        while True:
            load = await task_queues[task_id].get()
            await websocket.send_json(load)
            if load["status"] in ("completed", "failed"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        del task_queues[task_id]

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)