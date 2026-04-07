from pydantic import BaseModel, Field
from typing import List, Tuple, Optional, Union
from typing_extensions import Literal

class StartUploadRequest(BaseModel):
    filename: str
    content_type: str
    file_size: int

class StartUploadResponse(BaseModel):
    urls: List[str]
    chunk_size: int 
    key: str
    upload_id: str 

class CompleteUploadRequest(BaseModel):
    key: str
    upload_id: str 
    etags: str

class CompleteUploadResponse(BaseModel):
    url: str
    task_id: str
    frame: str
    setup_pts: List[List[int]]

class AnalyseRequest(BaseModel):
    task_id: str
    points: List[Tuple[float, float]]

class SingleCorrection(BaseModel):
    frame_idx: int
    track_id: int
    action: Literal["DELETE", "TRACK"]
    target_id: Optional[int] = None
    new_box: Optional[List[float]] = None

class PlayerState(BaseModel):
    track_id: int
    bbox: List[float]
    
class SwitchRangeCorrection(BaseModel):
    action: Literal["SWITCH"]
    start_frame: int
    end_frame: int
    start_state: List[PlayerState] = Field(..., max_length=2, min_length=2)
    end_state: List[PlayerState] = Field(..., max_length=2, min_length=2)

class TrackCorrection(BaseModel):
    action: Literal["TRACK"]
    trackId: int
    frames: List[int]
    bboxes: List[List[float]]

class BatchCorrectionRequest(BaseModel):
    task_id: str
    points: List[Tuple[float, float]]
    corrections: List[Union[SwitchRangeCorrection, SingleCorrection,TrackCorrection]]