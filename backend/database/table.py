from sqlalchemy import Column, Integer, String, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class FrameDetectionSchema:
    id          = Column(Integer, primary_key=True, autoincrement=True)
    task_id     = Column(String, nullable=False)
    frame_id    = Column(Integer, nullable=False)
    detections  = Column(JSONB, nullable=False)

class FrameDetection(FrameDetectionSchema,Base):
    __tablename__ = "Results"
    __table_args__ = (
        Index("ix_frame_detections_task_frame", "task_id", "frame_id"),
    )
