from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import select, delete, update, func
from database.table import FrameDetection

def get_detection_by_frame(db: Session, task_id: str, frame_id: int) -> FrameDetection | None:
    """Fetches a single frame's detections synchronously."""
    result = db.execute(
        select(FrameDetection).where(
            FrameDetection.task_id == task_id,
            FrameDetection.frame_id == frame_id
        )
    )
    return result.scalar_one_or_none()

def insert_bulk(db: Session, data: list[dict]):
    if not data:
        return 
    db.bulk_insert_mappings(FrameDetection, data)
    db.commit()

def get_all_detections_for_task(db: Session, task_id: str):
    return db.query(FrameDetection).filter(
        FrameDetection.task_id == task_id
        ).order_by(FrameDetection.frame_id.asc()).all()

def replace_bulk_frames(db: Session, data: list[dict]):
    if not data:
        return 
    try:
        task_id = data[0]["task_id"]
        frame_ids = [item["frame_id"] for item in data]
        
        stmt = delete(FrameDetection).where(
            FrameDetection.task_id == task_id,
            FrameDetection.frame_id.in_(frame_ids)
        )
        db.execute(stmt)
        db.bulk_insert_mappings(FrameDetection, data)
        db.commit()

    except Exception as e:
        db.rollback()
        raise e

def get_detections_in_range(db: Session, task_id: str, start_frame: int, end_frame: int):

    return db.query(FrameDetection).filter(
        FrameDetection.task_id == task_id,
        FrameDetection.frame_id >= start_frame,
        FrameDetection.frame_id <= end_frame
    ).order_by(FrameDetection.frame_id.asc()).all()

def delete_tracks_bulk(db: Session, task_id: str, track_ids: list):
    for tid in track_ids:
        stmt = (
            update(FrameDetection)
            .where(FrameDetection.task_id == task_id)
            .values(
                detections=func.jsonb_path_query_array(
                    FrameDetection.detections,
                    f'$[*] ? (@.track_id != {tid})'
                )
            )
        )
        db.execute(stmt)
    db.commit()

def swap_ids_from_frame(db: Session, task_id: str, id1: int, id2: int, start_frame: int):
    rows = db.query(FrameDetection).filter(
        FrameDetection.task_id == task_id,
        FrameDetection.frame_id >= start_frame
    ).all()
    
    for row in rows:
        updated = False
        
        for det in row.detections:
            if det.get("track_id") == id1:
                det["track_id"] = id2
                updated = True
            elif det.get("track_id") == id2:
                det["track_id"] = id1
                updated = True
        
        if updated:
            flag_modified(row, "detections")
            
    db.commit()