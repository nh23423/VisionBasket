import os
import cv2
import numpy as np
import torch
import json
import traceback
import redis
from pathlib import Path
from collections import defaultdict
from celery import Celery
from helper import homography, process_batch_detections, assign_state, find_switch_point, is_fully_inframe, get_crop_frame_coords, reid_score_match, iou_box
from track import ObjectTracker
from boxmot import BotSort
from rfdetr import RFDETRMedium
from common import TrackState
from reid import ReIDPredictor
from upload import UploadVideo
from database import crud_sync
from database.connect import SyncSessionLocal
from config import Config
from database.table import FrameDetection

REDIS_URL = Config.REDIS_URL
app = Celery("task", broker=REDIS_URL, backend=REDIS_URL)
redis_client = redis.from_url(REDIS_URL)

# The Scratch Space
TEMP_DISK_FOLDER = Path("/tmp/video_scratch")
TEMP_DISK_FOLDER.mkdir(parents=True, exist_ok=True)

BUCKET_NAME = Config.BUCKET_NAME
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

if torch.cuda.is_available():
    DEVICE = torch.device('cuda')
elif torch.backends.mps.is_available():
    DEVICE = torch.device('mps')
else:
    DEVICE = torch.device('cpu')
if DEVICE.type == 'cuda':
    torch.autocast(device_type="cuda", dtype=torch.float16).__enter__()

# Object Detector Initialization
RFDETR_CHECKPOINT = Config.WEIGHTS_PATH
model = None
# try:
#     model.optimize_for_inference(batch_size=8)
# except AttributeError:
#     pass

reid_model = ReIDPredictor(DEVICE)
print("Models Ready.")

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
            highest_score,best_match_id = reid_score_match(active_tracks,sig1,reid_model)

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

def publish_ws(task_id, data):
    redis_client.publish(f"ws_{task_id}", json.dumps(data))
    
@app.task(name="batch_insertion", ignore_result=True)
def insert_detections(batch_data: list[dict]):
    with SyncSessionLocal() as db:
        crud_sync.insert_bulk(db, batch_data)

@app.task(name="replace_batch", ignore_result=True)
def rep_detections(batch_data: list[dict]):
    with SyncSessionLocal() as db:
        crud_sync.replace_bulk_frames(db, batch_data)
 
@app.task(name="execute_tracking_pipeline", bind=True)
def execute_tracking_pipeline(self, task_id: str, pts: list):
    global model 
    
    if model is None:
        print("Loading RF-DETR model...")
        model = RFDETRMedium(pretrain_weights=RFDETR_CHECKPOINT)
    
    try:
        model.optimize_for_inference(batch_size=8)
    except AttributeError:
        pass
    
    H = homography(pts, DEST)
    s3_key = f"{task_id}.mp4"
    local_input_path = str(TEMP_DISK_FOLDER / s3_key)
    uploader = UploadVideo()
    
    try:
        uploader.download_file(BUCKET_NAME, s3_key, local_input_path)
        tracker = BotSort(reid_weights=None, device=DEVICE, half=True, with_reid=False)
        cap = cv2.VideoCapture(local_input_path)
        fps, total_frames = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        publish_ws(task_id, {"status": "started", "fps": fps})
        active_tracks, id_mapping, idx, batch, temp_ws = {}, {}, 0, [], []
        
        BATCH_SIZE = 8
        frame_buffer, idx_buffer = [], []

        while cap.isOpened() or len(frame_buffer) > 0:
            ret, frame = (False, None)
            if cap.isOpened():
                ret, frame = cap.read()
                if ret:
                    idx += 1
                    frame_buffer.append(frame)
                    idx_buffer.append(idx)
                else: cap.release()

            if len(frame_buffer) == BATCH_SIZE or (not cap.isOpened() and len(frame_buffer) > 0):
                leftover = len(frame_buffer)
                if leftover < BATCH_SIZE:
                    inference_buffer = list(frame_buffer)
                    
                    # Pad the buffer with the last frame of the existing frames.
                    padding_needed = BATCH_SIZE - leftover
                    for _ in range(padding_needed):
                        inference_buffer.append(inference_buffer[-1])
                    
                    batch_results = model.predict(inference_buffer, threshold=CONFIDENCE_THRESHOLD)
                    batch_results = batch_results[:leftover]
                else:  
                    batch_results = model.predict(frame_buffer, threshold=CONFIDENCE_THRESHOLD)
                    
                processed_batch_dets = process_batch_detections(batch_results, [4, 5, 6, 7, 8, 10])
                
                for i, current_frame in enumerate(frame_buffer):
                    f_idx = idx_buffer[i]
                    current_bbox, results, mp = [], [], []

                    dets_to_sort =  processed_batch_dets[i]

                    tracks = tracker.update(dets_to_sort, current_frame)
                    active_tracks, frame_tracks = track_processing(tracks, id_mapping, active_tracks, width, height, f_idx, current_frame)
                    
                    for tid in [t for t in active_tracks if t not in frame_tracks]: 
                        active_tracks[tid].dis_cont = True 

                    for id1, t1 in active_tracks.items():
                        if t1.dis_cont: 
                            continue 
                        assign_state(t1, active_tracks, id1, current_frame, width, height, f_idx)
                        x1, y1, x2, y2 = map(int, t1.bbox)
                        input_pt = np.array([[[int((x1+x2)/2), y2]]], dtype=np.float32)
                        tx, ty = cv2.perspectiveTransform(input_pt, H)[0][0]
                        
                        current_bbox.append({
                            "id": int(id1), 
                            "bbox": [x1, y1, x2, y2], 
                            "conf": float(t1.confidence),
                            "class_id": int(t1.class_id)
                        })
                        mp.append([float(tx), float(ty)])
                        results.append({
                            "track_id": int(id1), "x1": float(x1), "y1": float(y1),
                            "x2": float(x2), "y2": float(y2), "mx": float(tx), 
                            "my": float(ty), "conf": float(t1.confidence), "class_id": int(t1.class_id)
                        })

                    temp_ws.append({"frame_id": f_idx, "detections": current_bbox, "mapped_points": mp})
                    batch.append({"task_id": task_id, "frame_id": f_idx, "detections": results})

                if len(temp_ws) >= 5 or not cap.isOpened():
                    publish_ws(task_id, {"status": "processing", "progress": int((idx/total_frames)*100), "frames": temp_ws})
                    temp_ws = []
                if len(batch) >= 100 or not cap.isOpened():
                    with SyncSessionLocal() as db: 
                        crud_sync.insert_bulk(db, batch)
                    batch = []
                frame_buffer, idx_buffer = [], []

        publish_ws(task_id, {"status": "completed", "progress": 100})
    except Exception as e:
        traceback.print_exc()
        publish_ws(task_id, {"status": "failed", "error": str(e)})
    finally:
        if os.path.exists(local_input_path): os.remove(local_input_path)

@app.task(name="execute_corrections", bind=True)
def execute_corrections_task(self, task_id: str, pts: list, corrections: list):
    H = homography(pts, DEST)
    s3_key = f"{task_id}.mp4"
    local_input_path = str(TEMP_DISK_FOLDER / s3_key)
    uploader = UploadVideo()
    cap = None
    
    try:
        uploader.download_file(BUCKET_NAME, s3_key, local_input_path)
        cap = cv2.VideoCapture(local_input_path)
        fps, total_frames = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        publish_ws(task_id, {"status": "started", "fps": fps})
        
        with SyncSessionLocal() as db:
            
            deleted_ids = {c["track_id"] for c in corrections if c["action"] == "DELETE"}
            if deleted_ids:
                crud_sync.delete_tracks_bulk(db, task_id, list(deleted_ids))
                
            track_corrections = [c for c in corrections if c["action"] == "TRACK"]
            for tc in track_corrections:
                t_id, f_list, b_list = tc["trackId"], tc["frames"], tc["bboxes"]
                for i, f_id in enumerate(f_list):
                    x1, y1, x2, y2 = b_list[i]
                    
                    px, py = (x1 + x2) / 2, y2 
                    src_pt = np.array([[[px, py]]], dtype=np.float32)
                    dst_pt = cv2.perspectiveTransform(src_pt, H)
                    mx, my = float(dst_pt[0][0][0]), float(dst_pt[0][0][1])

                    crud_sync.update_manual_track_with_iou(
                        db, task_id, t_id, f_id, [x1, y1, x2, y2], mx, my
                    )
            
            range_corrections = [c for c in corrections if c["action"] == "SWITCH"]
            
            for rc in range_corrections:
                start, end = rc["start_frame"], rc["end_frame"]
                id1 = int(rc["start_state"][0]["track_id"])
                id2 = int(rc["start_state"][1]["track_id"])
                
                track_data1, track_data2, frames = {}, {}, {}
                cap.set(cv2.CAP_PROP_POS_FRAMES, start - 1)
                
                range_data = crud_sync.get_detections_in_range(db, task_id, start, end)
                range_dict = {}
                for row in range_data:
                    range_dict[row.frame_id] = row.detections
                
                for i in range(start, end + 1):
                    ret, frame = cap.read()
                    if not ret: break
                    frames[i] = frame
                    
                    for d in range_dict.get(i, []):
                        if d.get("track_id") == id1: track_data1[i] = [d["x1"], d["y1"], d["x2"], d["y2"]]
                        elif d.get("track_id") == id2: track_data2[i] = [d["x1"], d["y1"], d["x2"], d["y2"]]
                
                switched_f = find_switch_point(track_data1, track_data2, width, height, frames,reid_model)
                
                if switched_f:
                    crud_sync.swap_ids_from_frame(db, task_id, id1, id2, switched_f)
        
        temp_ws = []
        
        query = db.query(FrameDetection).filter(FrameDetection.task_id == task_id).order_by(FrameDetection.frame_id.asc())
        
        # PUll 100 frame values from the database at a time
        for row in query.yield_per(100):
            current_bbox, mp = [], []
                
            for d in row.detections:

                current_bbox.append({
                    "id": d["track_id"], 
                    "bbox": [d["x1"], d["y1"], d["x2"], d["y2"]], 
                    "conf": d.get("conf", 1.0)
                })
                mp.append([d["mx"], d["my"]])

            temp_ws.append({"frame_id": row.frame_id, "detections": current_bbox, "mapped_points": mp})
            
            # Stream every 5 frames and clear the buffer
            if len(temp_ws) >= 5 or row.frame_id == total_frames:
                publish_ws(task_id, {"status": "processing", "progress": int((row.frame_id/total_frames)*100), "frames": temp_ws})
                temp_ws = []
        
        publish_ws(task_id, {"status": "completed", "progress": 100})
    
    except Exception as e:
        traceback.print_exc()
        publish_ws(task_id, {"status": "failed", "error": str(e)})
    finally:
        if cap: cap.release()
        if os.path.exists(local_input_path): 
            os.remove(local_input_path)