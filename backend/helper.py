
import cv2 
import numpy as np 
from reid import ReIDPredictor
from common import TrackState

# Helper functions
def iou_box(box1, box2):
    xA = max(box1[0],box2[0])
    yA = max(box1[1],box2[1])
    xB = min(box1[2],box2[2])
    yB = min(box1[3],box2[3])
    interWidth = max(0, xB-xA)
    interHeight = max(0, yB-yA)
    interArea = interWidth * interHeight
    box1Area = (box1[2] - box1[0]) * (box1[3] - box1[1])
    box2Area = (box2[2] - box2[0]) * (box2[3] - box2[1])
    return interArea / float(box1Area+box2Area-interArea)

def is_fully_inframe(bbox, frame_w, frame_h, margin=20):
    x1, y1, x2, y2 = bbox
    return x1 > margin and y1 > margin and x2 < frame_w - margin and y2 < frame_h - margin

def resize_keep_aspect(img, target_h=200):
    h, w = img.shape[:2]
    scale = target_h / h
    return cv2.resize(img, (int(w * scale), target_h))

def get_crop_frame_coords(box, w, h, padding = 10):
    x1 = max(0, int(box[0]) - padding)
    y1 = max(0, int(box[1]) - padding)
    
    x2 = min(w, int(box[2]) + padding)
    y2 = min(h, int(box[3]) + padding)
    
    return [x1, y1, x2, y2]

def homography(pts,dst):
    src_pts = np.array(pts, dtype=np.float32)
    dst_pts = np.array(dst, dtype=np.float32)
    H, _ = cv2.findHomography(src_pts,dst_pts,cv2.RANSAC,5.0)
    return H

def process_batch_detections(batch_results, relevant_ids):
    formatted_detections = []
    
    for result in batch_results:
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
            
        formatted_detections.append(dets_to_sort)
        
    return formatted_detections

# Appearance matching
def reid_score_match(active_tracks,sig1,reid_model):
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

def find_switch_point(track_data1: dict, track_data2: dict, width: int, height: int, frames: dict,reid_model: ReIDPredictor):
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
