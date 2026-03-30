from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from database.table import FrameDetection

### CREATE ###

async def create_frame_detection(db: AsyncSession, task_id: str, frame_id: int, detections_data: dict | list) -> FrameDetection:
    """Inserts a new frame detection record."""
    new_frame = FrameDetection(
        task_id=task_id,
        frame_id=frame_id,
        detections=detections_data
    )
    db.add(new_frame)
    await db.commit()
    await db.refresh(new_frame)
    return new_frame


### READ ###

async def get_detection_by_frame(db: AsyncSession, task_id: str, frame_id: int) -> FrameDetection | None:
    """Fetches a single frame's detections. (Hits your composite index!)"""
    result = await db.execute(
        select(FrameDetection).where(
            FrameDetection.task_id == task_id,
            FrameDetection.frame_id == frame_id
        )
    )
    return result.scalar_one_or_none()

async def get_all_detections_for_task(db: AsyncSession, task_id: str) -> list[FrameDetection]:
    """Fetches all frame detections for a specific task."""
    result = await db.execute(
        select(FrameDetection)
        .where(FrameDetection.task_id == task_id)
        .order_by(FrameDetection.frame_id)
    )
    return list(result.scalars().all())


### UPDATE ###

async def update_frame_detections(db: AsyncSession, task_id: str, frame_id: int, new_detections: dict | list) -> FrameDetection | None:
    """Overwrites the JSONB detections for a specific frame."""
    result = await db.execute(
        select(FrameDetection).where(
            FrameDetection.task_id == task_id,
            FrameDetection.frame_id == frame_id
        )
    )
    frame_record = result.scalar_one_or_none()
    
    if frame_record:
        frame_record.detections = new_detections
        await db.commit()
        await db.refresh(frame_record)
        
    return frame_record

### DELETE ###
async def delete_frame_detection(db: AsyncSession, task_id: str, frame_id: int) -> bool:
    """Deletes a specific frame's record. Returns True if deleted, False if not found."""
    result = await db.execute(
        delete(FrameDetection).where(
            FrameDetection.task_id == task_id,
            FrameDetection.frame_id == frame_id
        )
    )
    await db.commit()
    return result.rowcount > 0