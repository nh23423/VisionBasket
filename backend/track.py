
from common import TrackState
from helper import get_crop_frame_coords

class ObjectTracker:
    def __init__(self, track_id, box, confidence, frame_idx, class_id):
        self.id = track_id 
        self.bbox = box 
        self.confidence = confidence 
        self.class_id = class_id

        self.track_state =  TrackState.SAFE
        self.dis_cont= False 
        
        self.cache_frame = [] 
        self.risk_frame = None
        self.max_len = 3 

    def update_cache(self,box,frame,frame_idx,conf):
        x1, y1, x2, y2 = get_crop_frame_coords(box, frame.shape[1], frame.shape[0])
        tar_frame = frame[y1:y2, x1:x2].copy()
        
        if self.track_state == TrackState.SAFE:
            
            if not self.cache_frame:
                self.cache_frame.append((tar_frame,conf))
            else:
                target_idx = 0 
                for item in self.cache_frame:
                    if item[1] >= conf:
                        self.cache_frame.insert(target_idx,(tar_frame,conf))
                        break
                    else:
                        if target_idx == len(self.cache_frame) - 1:
                            self.cache_frame.append((tar_frame,conf))
                        else:
                            target_idx += 1
                if len(self.cache_frame) == self.max_len:
                    self.cache_frame.pop(0)
                            
        elif self.track_state == TrackState.RISK:
            if not self.risk_frame or conf > self.risk_frame[1]:
                self.risk_frame =  (tar_frame,conf)    
        
    
