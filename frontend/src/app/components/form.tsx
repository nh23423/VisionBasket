'use client';

import { zodResolver } from "@hookform/resolvers/zod";
import { SubmitHandler, useForm } from "react-hook-form";
import { z } from "zod";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { APIService, Detection, SingleCorrection, PlayerState, SwitchRangeCorrection, MergeCorrection} from "../services/api.service";
import VideoPlayer from './videoplayer';
import CourtDisplay from "./court";
import Dashboard from "./dash";

const EditIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>;
const CheckIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>;
const AlertIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="orange" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>;
const LoaderIcon = () => <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>;
const TrackIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/><circle cx="12" cy="12" r="3"/></svg>;
const UndoIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path></svg>;
const ChartIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>;
const VideoIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>;

const COLORS = [
  '#FF4136', '#2ECC40', '#0074D9', '#FF69B4', '#FF851B',
  '#B10DC9', '#01FF70', '#FFDC00', '#7FDBFF', '#F012BE',
];

const videoSchema = z.object({
  video: z.any()
    .refine((files) => files?.length === 1, "Please select a video file.")
    .refine((files) => files?.[0]?.size <= 2000 * 1024 * 1024, "Max file size is 2GB.")
    .refine((files) => files?.[0]?.type.startsWith("video/"), "Only video files (mp4, mov, etc.) are accepted."),
});

type VideoFormValues = z.infer<typeof videoSchema>;

interface ExtendedDetection extends Detection {
  isManualKeyframe?: boolean;
  isInterpolated?: boolean;
}

export default function VideoUploadForm() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "setup" | "uploading" | "processing" | "done">("idle");
  const [courtPts, setCourtPts] = useState<[number, number][]>([]);

  const [viewMode, setViewMode] = useState<'correction' | 'dashboard'>('correction');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const setUpCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | 'eraser' | 'switch' | 'track' | null>('select');
  const [firstSelectedId, setFirstSelectedId] = useState<number | null>(null);
  const [idLabels, setIdLabels] = useState<Record<number, string>>({});
  const [hiddenIds, setHiddenIds] = useState<Record<number, number>>({});
  const totalFramesRef = useRef<number>(0);
  const [renamingId, setRenamingId] = useState<{id: number, x: number, y: number} | null>(null);
  const [fileUploadProgress, setFileUploadProgress] = useState(0);
  const [lastKnownStates, setLastKnownStates] = useState<Map<number, {bbox: number[], mx: float, my: float}>>(new Map());
  const [allSeenIds, setAllSeenIds] = useState<number[]>([]);
  
  // Correction Tracking
  const [correctionsBatch, setCorrectionsBatch] = useState<(SingleCorrection | SwitchRangeCorrection | MergeCorrection)[]>([]);
  const [editHistory, setEditHistory] = useState<{frame: number, action: string, target: string}[]>([]);

  const [switchPhase, setSwitchPhase] = useState<'idle' | 'select_start' | 'seek_end' | 'select_end'>('idle');
  const [switchRangeData, setSwitchRangeData] = useState<{
      start_frame?: number,
      end_frame?: number,  
      start_state: PlayerState[], 
      end_state: PlayerState[]
  }>({ start_state: [], end_state: [] });

  const [addTrackState, setAddTrackState] = useState<{
    step: 'idle' | 'waiting_for_end';
    startFrame: number | null;
    startBbox: number[] | null;
  }>({ step: 'idle', startFrame: null, startBbox: null });
  
  // Manual Tracking State
  const [addingTrackId, setAddingTrackId] = useState<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const manualTracksRef = useRef<Map<number, {frame: number, bbox: number[]}[]>>(new Map());

  // Drawing Refs
  const isDrawingRef = useRef(false);
  const drawStartRef = useRef({x: 0, y: 0});
  const drawCurrentRef = useRef({x: 0, y: 0});

  const frameDataRef = useRef<Map<number, { detections: ExtendedDetection[], mapped_points: [number, number][] }>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const requestRef = useRef<number | null>(null);
  const fpsRef = useRef<number>(30);
  const [setupFrameUrl, setSetupFrameUrl] = useState<string | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const [points, setPoints] = useState<[number, number][]>([]);
  const [mapPts, setMapPts] = useState<{ id: number; pt: [number, number] }[]>([]);

  const { register, handleSubmit, watch, reset } = useForm<VideoFormValues>({ resolver: zodResolver(videoSchema) });
  const videoFile = watch("video");

  useEffect(() => {
    if (videoFile && videoFile.length > 0) {
      const url = URL.createObjectURL(videoFile[0]);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [videoFile]);

  // Pinpoint mouse position math 
  const getMousePos = (clientX: number, clientY: number, canvas: HTMLCanvasElement) => {
    const video = videoRef.current;
    if (!video) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const videoRatio = video.videoWidth / video.videoHeight;
    const containerRatio = rect.width / rect.height;
    
    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (containerRatio > videoRatio) {
        renderedWidth = rect.height * videoRatio;
        offsetX = (rect.width - renderedWidth) / 2;
    } else {
        renderedHeight = rect.width / videoRatio;
        offsetY = (rect.height - renderedHeight) / 2;
    }

    const scaleX = video.videoWidth / renderedWidth;
    const scaleY = video.videoHeight / renderedHeight;

    const x = (clientX - rect.left - offsetX) * scaleX;
    const y = (clientY - rect.top - offsetY) * scaleY;
    
    return { x, y, scaleX, scaleY, offsetX, offsetY };
  };

  const getCurrentFrameIndex = useCallback(() => {
    const video = videoRef.current;

    if (!video) return 0;

    if (Number.isNaN(video.duration) || video.duration === 0) {
      return 1; 
    }

    const totalFrames = totalFramesRef.current;
    if (!totalFrames || totalFrames <= 0) {
      return 2; 
    }
    
    const progress = video.currentTime / video.duration;
    let frameIndex = Math.floor(progress * totalFrames);

    if (frameIndex >= totalFrames) {
        frameIndex = totalFrames - 1;
    }

    return Math.max(0, frameIndex);
  }, []);

  // Interpolation
  const handleInterpolate = useCallback((trackId: number, newFrame: number, newBbox: number[]) => {
    const trackKeyframes = manualTracksRef.current.get(trackId) || [];
    const existingIdx = trackKeyframes.findIndex(k => k.frame === newFrame);
    if (existingIdx >= 0) trackKeyframes.splice(existingIdx, 1);
    
    trackKeyframes.push({ frame: newFrame, bbox: newBbox });
    trackKeyframes.sort((a, b) => a.frame - b.frame);
    manualTracksRef.current.set(trackId, trackKeyframes);

    const applyInterp = (startK: {frame: number, bbox: number[]}, endK: {frame: number, bbox: number[]}) => {
        const gap = endK.frame - startK.frame;
        for(let f = startK.frame + 1; f < endK.frame; f++) {
            const alpha = (f - startK.frame) / gap;
            const ibbox = [
                startK.bbox[0] + (endK.bbox[0] - startK.bbox[0]) * alpha,
                startK.bbox[1] + (endK.bbox[1] - startK.bbox[1]) * alpha,
                startK.bbox[2] + (endK.bbox[2] - startK.bbox[2]) * alpha,
                startK.bbox[3] + (endK.bbox[3] - startK.bbox[3]) * alpha,
            ];
            let fd = frameDataRef.current.get(f);
            if(!fd) { fd = { detections: [], mapped_points: [] }; frameDataRef.current.set(f, fd); }
            fd.detections = fd.detections.filter((d: any) => d.id !== trackId);
            fd.detections.push({ id: trackId, bbox: ibbox as [number,number,number,number], conf: 1, isInterpolated: true });
        }
    };

    const idx = trackKeyframes.findIndex(k => k.frame === newFrame);
    if(trackKeyframes[idx - 1]) applyInterp(trackKeyframes[idx - 1], trackKeyframes[idx]);
    if(trackKeyframes[idx + 1]) applyInterp(trackKeyframes[idx], trackKeyframes[idx + 1]);

    let fd = frameDataRef.current.get(newFrame);
    if(!fd) { fd = { detections: [], mapped_points: [] }; frameDataRef.current.set(newFrame, fd); }
    fd.detections = fd.detections.filter((d: any) => d.id !== trackId);
    fd.detections.push({ id: trackId, bbox: newBbox as [number,number,number,number], conf: 1, isManualKeyframe: true });
    
    if (trackKeyframes.length > 1) {
        const framesToSend: number[] = [];
        const bboxesToSend: number[][] = [];
        
        const minFrame = trackKeyframes[0].frame;
        const maxFrame = trackKeyframes[trackKeyframes.length - 1].frame;

        for (let f = minFrame; f <= maxFrame; f++) {
            const currentFd = frameDataRef.current.get(f);
            if (currentFd) {
                const detection = currentFd.detections.find((d: any) => d.id === trackId);
                if (detection) {
                    framesToSend.push(f);
                    bboxesToSend.push(detection.bbox);
                }
            }
        }

        setCorrectionsBatch((prev: any) => [
            ...prev.filter((c: any) => !(c.action === 'TRACK' && c.trackId === trackId)), 
            {
                action: "TRACK",
                trackId: trackId,
                frames: framesToSend,
                bboxes: bboxesToSend
            }
        ]);
    }
  }, [setCorrectionsBatch]); 

  const handleMergeIds = useCallback((oldId: number, newId: number) => {
    // 1. Update the local data reference for all frames
    frameDataRef.current.forEach((frameData) => {
        const detIndex = frameData.detections.findIndex(d => d.id === oldId);
        if (detIndex !== -1) {
            const newIdExistsInFrame = frameData.detections.some(d => d.id === newId);
            if (newIdExistsInFrame) {
                // If the target ID already exists in this frame, remove the duplicate
                frameData.detections.splice(detIndex, 1);
            } else {
                // Otherwise, rename the detection
                frameData.detections[detIndex].id = newId;
            }
        }
    });

    setAllSeenIds(prev => {
        const updated = prev.filter(id => id !== oldId);
        if (!updated.includes(newId)) updated.push(newId);
        return updated.sort((a, b) => a - b);
    });

    setIdLabels(prev => {
        const newLabels = { ...prev };
        delete newLabels[oldId]; 
        return newLabels;
    });

    setEditHistory(prev => [{ frame: currentFrame, action: 'Track Merged', target: `#${oldId} → #${newId}` }, ...prev]);
    setCorrectionsBatch(prev => [...prev, { action: "MERGE", source_id: oldId, target_id: newId }]);

    if (videoRef.current) drawRef.current(getCurrentFrameIndex());
  }, [currentFrame]);

  const renderFrameWithSelection = useCallback((frameIndex: number, overrideId: number | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !video || canvas.width === 0) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const frameData = frameDataRef.current.get(frameIndex);
    if (!frameData) return;

    const pendingIds = new Set<number>();
    correctionsBatch.forEach(c => {
        if (c.action === 'SWITCH') {
            pendingIds.add(c.start_state[0].track_id);
            pendingIds.add(c.start_state[1].track_id);
        } else if (c.action === 'DELETE') {
            pendingIds.add(c.track_id);
        }
    });

    frameData.detections.forEach(({ id, bbox, isManualKeyframe, isInterpolated }) => {
      const deleteStartFrame = hiddenIds[id];
      if (deleteStartFrame !== undefined && frameIndex >= deleteStartFrame) {
          return; 
      }
      const [x1, y1, x2, y2] = bbox;
      
      const isBlockedAnchor = 
          (activeTool === 'switch' && switchPhase === 'select_start' && switchRangeData.start_state[0]?.track_id === id && frameIndex === switchRangeData.start_frame) ||
          (activeTool === 'switch' && switchPhase === 'select_end' && switchRangeData.end_state[0]?.track_id === id && frameIndex === switchRangeData.end_frame);

      const isSelected = 
          id === overrideId || 
          (activeTool === 'switch' && switchRangeData.start_state.some(s => s.track_id === id && frameIndex === switchRangeData.start_frame)) ||
          (activeTool === 'switch' && switchRangeData.end_state.some(s => s.track_id === id && frameIndex === switchRangeData.end_frame));
          
      const isPending = pendingIds.has(id);
      const baseColor = COLORS[id % COLORS.length];
      ctx.lineWidth = isSelected || isBlockedAnchor || isManualKeyframe ? 5 : 3;
      ctx.strokeStyle = isBlockedAnchor ? '#FF0000' : baseColor;
      if (isPending) ctx.setLineDash([5, 5]);
      else ctx.setLineDash([]);

      if (isPending) {
          ctx.setLineDash([5, 5]);
          ctx.strokeStyle = '#FF4136'; // Red for pending delete
      } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = baseColor;
      }

      // Highlight selected box with a shadow/glow
      if (isSelected) {
          ctx.shadowColor = '#FFFFFF';
          ctx.shadowBlur = 10;
          ctx.strokeStyle = '#FFFFFF'; // Make it pop white when selected
      } else {
          ctx.shadowBlur = 0;
      }

      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      
      // Reset for next box
      ctx.setLineDash([]); 
      ctx.shadowBlur = 0;
    });
  }, [selectedId, firstSelectedId, idLabels, hiddenIds, activeTool, switchPhase, switchRangeData, correctionsBatch]);

  const drawFrameIndex = useCallback((frameIndex: number) => {
    setCurrentFrame(prev => (prev === frameIndex ? prev : frameIndex));

    const frameData = frameDataRef.current.get(frameIndex);
    if (!frameData) return;

    setLastKnownStates(prevMap => {
        const newMap = new Map(prevMap);
        let hasChanged = false;

        frameData.detections.forEach((det, idx) => {
            const mx_my = frameData.mapped_points[idx] || [0, 0];
            newMap.set(det.id, {
                bbox: det.bbox,
                mx: mx_my[0],
                my: mx_my[1]
            });
            hasChanged = true;
        });

        if (hasChanged) {
            setAllSeenIds(prevIds => {
                const newIds = Array.from(newMap.keys()).sort((a, b) => a - b);
                return JSON.stringify(prevIds) === JSON.stringify(newIds) ? prevIds : newIds;
            });
            return newMap;
        }
        return prevMap;
    });

    setMapPts(() => {
        return frameData.detections.map((det, idx) => ({
            id: det.id,
            pt: frameData.mapped_points[idx] || [0, 0]
        }));
    });

    renderFrameWithSelection(frameIndex, selectedId);
  }, [selectedId, renderFrameWithSelection]);

  const drawRef = useRef(drawFrameIndex);
  useEffect(() => { drawRef.current = drawFrameIndex; }, [drawFrameIndex]);

  // Handle Playback/Seeking
  const onVideoFrameCallback = useCallback((now: number, metadata: any) => {
    const video = videoRef.current;
    
    if (video) {
        let frameIndex;

        if (video.duration > 0 && totalFramesRef.current > 0) {
            const progress = metadata.mediaTime / video.duration;
            frameIndex = Math.floor(progress * totalFramesRef.current);
        } else {
            frameIndex = Math.round(metadata.mediaTime * fpsRef.current);
        }
        frameIndex = getCurrentFrameIndex();
        drawRef.current(frameIndex);
    }

    if (video && 'requestVideoFrameCallback' in video) {
        requestRef.current = (video as any).requestVideoFrameCallback(onVideoFrameCallback);
    }
  }, []);

  const startLoop = useCallback(() => {
    const video = videoRef.current;
    if (video && 'requestVideoFrameCallback' in video) {
        if (requestRef.current) (video as any).cancelVideoFrameCallback(requestRef.current);
        requestRef.current = (video as any).requestVideoFrameCallback(onVideoFrameCallback);
    }
  }, [onVideoFrameCallback]);

  useEffect(() => {
    if (renamingId && videoRef.current) {
      videoRef.current.pause();
    }
  }, [renamingId]);

  useEffect(() => {
    // Reset the active manual ID when switching tools
    if (activeTool !== 'track') {
        setAddingTrackId(null);
    }
    // Reset when clicking off
    if (activeTool !== 'switch') {
        setSwitchPhase('idle');
        setSwitchRangeData({ start_state: [], end_state: [] });
    }
  }, [activeTool]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        
        // Add safety checks for select and option tags
        if (
            target.closest('#rename-popup') || 
            target.closest('button') || 
            target.closest('input') || 
            target.closest('canvas') ||
            target.tagName.toLowerCase() === 'option' ||
            target.tagName.toLowerCase() === 'select'
        ) {
            return; 
        }

        // Otherwise, they clicked "off" into the background. Drop everything.
        setActiveTool(null); 
        setSelectedId(null);
        setRenamingId(null);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;

    const stopEvent = (e: Event) => {
      e.stopPropagation();
    };

    // We attach these in the BUBBLE phase (no 'true' argument).
    // This allows the <select> to open, but stops the click from reaching the document.
    popup.addEventListener('mousedown', stopEvent);
    popup.addEventListener('pointerdown', stopEvent);
    popup.addEventListener('click', stopEvent);
    popup.addEventListener('touchstart', stopEvent);

    return () => {
      popup.removeEventListener('mousedown', stopEvent);
      popup.removeEventListener('pointerdown', stopEvent);
      popup.removeEventListener('click', stopEvent);
      popup.removeEventListener('touchstart', stopEvent);
    };
  }, [renamingId]);


  useEffect(() => {
    const video = videoRef.current;
    if (video && video.paused && isVideoLoaded) {
        const frameIndex = getCurrentFrameIndex();
        drawRef.current(frameIndex);
    }

  }, [selectedId, hiddenIds, idLabels, activeTool, switchPhase, switchRangeData, isVideoLoaded]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || (status !== 'done' && status !== 'processing') || viewMode !== 'correction') return;

    const onPointerDown = (e: PointerEvent) => {
        if (renamingId) {
            setRenamingId(null);
            return;
        }
        const { x, y, scaleX, scaleY, offsetX, offsetY } = getMousePos(e.clientX, e.clientY, canvas);
        const frameIndex = getCurrentFrameIndex();

        if (activeTool === 'track') {
            isDrawingRef.current = true;
            drawStartRef.current = { x, y };
            drawCurrentRef.current = { x, y };
            return;
        } 

        const currentDetections = frameDataRef.current.get(frameIndex)?.detections ?? [];
        
        const hits = currentDetections.filter(d => {
            const deleteFrame = hiddenIds[d.id];
            const isVisible = deleteFrame === undefined || frameIndex < deleteFrame;
            
            return (
                isVisible &&
                x >= d.bbox[0] && x <= d.bbox[2] && 
                y >= d.bbox[1] && y <= d.bbox[3]
            );
        });
        
        hits.sort((a, b) => {
            const areaA = (a.bbox[2]-a.bbox[0]) * (a.bbox[3]-a.bbox[1]);
            const areaB = (b.bbox[2]-b.bbox[0]) * (b.bbox[3]-b.bbox[1]);
            return areaA - areaB;
        });
        
        const clickedId = hits.length > 0 ? hits[0].id : null;

        if (clickedId === null) {
            setSelectedId(null);
            setRenamingId(null);
            setActiveTool(null); 
            return; 
        }

        if (clickedId !== null) {
            const isPending = correctionsBatch.some(c => 
                (c.action === 'SWITCH' && (c.start_state[0].track_id === clickedId || c.start_state[1].track_id === clickedId)) ||
                (c.action === 'DELETE' && c.track_id === clickedId)
            );
            
            if (isPending) {
                alert("This player has a pending edit. Please wait for the current sync to complete, or push your corrections before editing them again.");
                return; 
            }
        }

        if (activeTool === 'eraser' && clickedId !== null) {
          const frameIndex = getCurrentFrameIndex();

          // Update UI state: Hide this ID ONLY from this frame forward
          setHiddenIds(prev => ({
              ...prev,
              [clickedId]: frameIndex
          }));

          setEditHistory(prev => [{ 
              frame: frameIndex, 
              action: 'Delete (Trailing)', 
              target: `ID ${clickedId}` 
          }, ...prev]);

          setCorrectionsBatch(prev => [
              ...prev, 
              { frame_idx: frameIndex, track_id: clickedId, action: "DELETE" }
          ]);
      } else if (activeTool === 'switch' && clickedId !== null) {
            
            const isBlockedAnchor = 
                (switchPhase === 'select_start' && switchRangeData.start_state[0]?.track_id === clickedId) ||
                (switchPhase === 'select_end' && switchRangeData.end_state[0]?.track_id === clickedId);
            
            if (isBlockedAnchor) {
                return; 
            }

            const clickedBox = hits[0].bbox;
            const playerState: PlayerState = { track_id: clickedId, bbox: clickedBox };

            if (switchPhase === 'idle') {
                setSwitchRangeData({ start_frame: frameIndex, start_state: [playerState], end_state: [] });
                setSwitchPhase('select_start');
            } 
            else if (switchPhase === 'select_start') {
                if (frameIndex !== switchRangeData.start_frame) {
                    alert("Please select the second player on the EXACT SAME FRAME as the first player.");
                    return;
                }
                setSwitchRangeData(prev => ({ ...prev, start_state: [...prev.start_state, playerState] }));
                setSwitchPhase('seek_end');
            } 
            else if (switchPhase === 'seek_end') {
                if (frameIndex <= switchRangeData.start_frame!) {
                    alert("Please seek forward to a frame AFTER the ID mix-up.");
                    return;
                }
                setSwitchRangeData(prev => ({ ...prev, end_frame: frameIndex, end_state: [playerState] }));
                setSwitchPhase('select_end');
            } 
            else if (switchPhase === 'select_end') {
                if (frameIndex !== switchRangeData.end_frame) {
                    alert("Please select the second player on the EXACT SAME FRAME as the first player.");
                    return;
                }

                const finalData = {
                    ...switchRangeData,
                    end_frame: switchRangeData.end_frame || frameIndex,
                    end_state: [...switchRangeData.end_state, playerState]
                };

                const correction: SwitchRangeCorrection = {
                    action: "SWITCH",
                    start_frame: finalData.start_frame!,
                    end_frame: finalData.end_frame!,
                    start_state: finalData.start_state as [PlayerState, PlayerState],
                    end_state: finalData.end_state as [PlayerState, PlayerState]
                };

                setCorrectionsBatch(prev => [...prev, correction]);
                setEditHistory(prev => [{ 
                    frame: finalData.end_frame!, 
                    action: 'Range Swap', 
                    target: `Frames ${finalData.start_frame}-${finalData.end_frame}` 
                }, ...prev]);

                setSwitchPhase('idle');
                setSwitchRangeData({ start_state: [], end_state: [] });
            }
        } else if (activeTool === 'select') {
              if (clickedId !== null) {
              setSelectedId(clickedId);
              const screenX = (hits[0].bbox[0] / scaleX) + offsetX;
              const screenY = (hits[0].bbox[1] / scaleY) + offsetY;
              setRenamingId({ id: clickedId, x: screenX, y: screenY });
          } else {
              // Clicked empty space, deselect
              setSelectedId(null);
              setRenamingId(null);
          }
        }
    };

    const onPointerMove = (e: PointerEvent) => {
        if (!isDrawingRef.current || activeTool !== 'track') return;
        const { x, y } = getMousePos(e.clientX, e.clientY, canvas);
        drawCurrentRef.current = { x, y };
        
        const frameIndex = getCurrentFrameIndex();
        drawRef.current(frameIndex); 
        
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.strokeStyle = '#ec4899'; ctx.lineWidth = 4; ctx.setLineDash([8, 8]);
          ctx.strokeRect(drawStartRef.current.x, drawStartRef.current.y, drawCurrentRef.current.x - drawStartRef.current.x, drawCurrentRef.current.y - drawStartRef.current.y);
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(236, 72, 153, 0.15)';
          ctx.fillRect(drawStartRef.current.x, drawStartRef.current.y, drawCurrentRef.current.x - drawStartRef.current.x, drawCurrentRef.current.y - drawStartRef.current.y);
        }
    };

    const onPointerUp = (e: PointerEvent) => {
        if (!isDrawingRef.current || activeTool !== 'track') return;
        isDrawingRef.current = false;
        const frameIndex = getCurrentFrameIndex();
        
        const start = drawStartRef.current;
        const end = drawCurrentRef.current;
        const x1 = Math.min(start.x, end.x); 
        const y1 = Math.min(start.y, end.y);
        const x2 = Math.max(start.x, end.x); 
        const y2 = Math.max(start.y, end.y);
        
        // Check if the box is a valid size
        if (x2 - x1 > 15 && y2 - y1 > 15) { 
            let targetId = addingTrackId;

            // MANDATORY ID CHECK
            if (targetId === null) {
                const input = window.prompt("Enter a valid Track ID for this manual track:");
                const parsed = parseInt(input || "");
                
                if (isNaN(parsed)) {
                    alert("A numeric Track ID is required to create a track.");
                    drawRef.current(frameIndex); // Redraw to clear the preview box
                    return;
                }
                targetId = parsed;
                setAddingTrackId(parsed); // Save it for subsequent clicks
            }

            handleInterpolate(targetId, frameIndex, [x1, y1, x2, y2]);
            setEditHistory(prev => [{ 
                frame: frameIndex, 
                action: 'Track Keyframe', 
                target: `ID ${targetId}` 
            }, ...prev]);
        } 
        drawRef.current(frameIndex);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
    }
  }, [status, activeTool, switchPhase, switchRangeData, hiddenIds, idLabels, handleInterpolate, correctionsBatch, viewMode, addingTrackId]);


const handleUndo = () => {
    if (correctionsBatch.length === 0) return;
    const lastCorrection = correctionsBatch[correctionsBatch.length - 1];
    
    if (lastCorrection.action === 'DELETE') {
      setHiddenIds(prev => {
          const next = { ...prev };
          delete next[lastCorrection.track_id];
          return next;
        });
    } else if (lastCorrection.action === 'TRACK') {
        const trackKeyframes = manualTracksRef.current.get(lastCorrection.track_id) || [];
        manualTracksRef.current.set(lastCorrection.track_id, trackKeyframes.filter(k => k.frame !== lastCorrection.frame_idx));
        frameDataRef.current.forEach((data) => {
            data.detections = data.detections.filter(d => !(d.id === lastCorrection.track_id && (d.isManualKeyframe || d.isInterpolated)));
        });
        const remaining = manualTracksRef.current.get(lastCorrection.track_id) || [];
        remaining.forEach(k => {
            const fd = frameDataRef.current.get(k.frame);
            if (fd) fd.detections.push({ id: lastCorrection.track_id, bbox: k.bbox as [number,number,number,number], conf: 1, isManualKeyframe: true });
        });
    }

    setCorrectionsBatch(prev => prev.slice(0, -1));
    setEditHistory(prev => prev.slice(1));
    if (videoRef.current) drawRef.current(getCurrentFrameIndex());
  };

  const onSetup = async () => {
    if (!videoFile || videoFile.length === 0) return;
    
    setStatus("uploading"); 
    setFileUploadProgress(0);
    frameDataRef.current.clear(); 
    setPoints([]);
    
    try {
        // Run the new upload flow
        const result = await APIService.upload(videoFile[0], (progress) => {
            setFileUploadProgress(progress);
        });

        taskIdRef.current = result.task_id; 
        setCourtPts(result.setup_pts); 
        setSetupFrameUrl(result.frame);
        
        setStatus("setup");
        
        console.log("Upload Complete:", result);
    
        
    } catch (err) {
        console.error("Upload Error:", err);
        setStatus("idle");
        alert("Upload failed. Check the console and MinIO CORS settings.");
    }
};

  const onSubmit = async () => {
    if (!taskIdRef.current) return;
    try {
      await APIService.analyse(taskIdRef.current, points);
      setStatus("processing"); 
      wsRef.current = APIService.connectToTask(taskIdRef.current, (data) => {
          if (data.status === "started") {
            fpsRef.current = data.fps ?? 30;
            totalFramesRef.current = data.total_frames ?? 0;
          }

          else if (data.status === "processing") {
            setProcessingProgress(data.progress || 0);
            data.frames?.forEach(f => frameDataRef.current.set(f.frame_id, { detections: f.detections, mapped_points: f.mapped_points }));
          } else if (data.status === "completed") { wsRef.current?.close(); setStatus("done"); }
        }, () => setStatus("idle"));
    } catch (err) { setStatus("idle"); }
  };

  const onCorrection = async () => {
    if (!taskIdRef.current || correctionsBatch.length === 0) return;
    try {
        setStatus("processing"); 
        setProcessingProgress(0); 

        await APIService.correction({ 
            task_id: taskIdRef.current, 
            points, 
            corrections: correctionsBatch 
        });
        
        setCorrectionsBatch([]); 
        setEditHistory([]);
       
        wsRef.current = APIService.connectToTask(taskIdRef.current, (data) => {
          if (data.status === "started") {
            fpsRef.current = data.fps ?? 30;
            totalFramesRef.current = data.total_frames ?? 0;
          }
          else if (data.status === "processing") {
            setProcessingProgress(data.progress || 0);
            data.frames?.forEach(f => frameDataRef.current.set(f.frame_id, { detections: f.detections, mapped_points: f.mapped_points }));
          } else if (data.status === "completed") {
            wsRef.current?.close(); 
            setStatus("done"); 
            setProcessingProgress(100); 
            if (videoRef.current && viewMode === 'correction') {
                drawRef.current(getCurrentFrameIndex());
            }
          } else if (data.status === "failed") { 
            console.error("Backend Task Failed:", data.error);
            wsRef.current?.close(); 
            setStatus("done"); 
            alert(`Correction failed: ${data.error}`); }
        }, () => {
            if (status !== "done") setStatus("idle");
        });

    } catch (err) { setStatus("done"); }
  };
 
  // Update new array without last element
  const onUndoPoint = () => {
    setPoints(prev => prev.slice(0, -1));
  };

  const handleStartAnalysis = () => {
      if (points.length !== 7) {
          alert(`You have currently plotted ${points.length} points. Please plot exactly 7 points on the video frame before proceeding.`);
          return;
      }
      onSubmit(); 
  };

  const onPointPlot = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (points.length >= 7) {
        alert("You have already plotted 7 points. Use 'Undo' if you need to make a correction.");
        return;
    }
    const canvas = setUpCanvasRef.current; 
    const img = canvas?.previousElementSibling as HTMLImageElement;
    if (!canvas || !img) return;

    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    setPoints(prev => [...prev, [x, y]]);
  };

  useEffect(() => {
    if (status !== 'setup' || !setUpCanvasRef.current) return;
    const canvas = setUpCanvasRef.current;
    const img = canvas.previousElementSibling as HTMLImageElement;
    if (!canvas || !img || img.naturalWidth === 0) return;

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height); // Wipe canvas clean
    const scale = canvas.width / canvas.offsetWidth;
    
    points.forEach((pt, i) => {
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 8 * scale, 0, Math.PI * 2); 
        ctx.fillStyle = '#00FF00'; ctx.fill();
        ctx.font = `bold ${10 * scale}px sans-serif`; ctx.fillStyle = '#000000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; 
        ctx.fillText(`${i + 1}`, pt[0], pt[1]); 
    });
  }, [points, status, setupFrameUrl]);

  if (status === "setup") {
    return (
      <div className="max-w-7xl mx-auto mt-6 px-4 animate-in fade-in zoom-in-95 duration-300">
        <div className="bg-white rounded-2xl border shadow-xl overflow-hidden flex flex-col">

          <div className="bg-blue-600 p-6 text-white">
            <h2 className="text-2xl font-bold mb-2">Camera Calibration Setup</h2>
            <p className="text-blue-100 max-w-3xl">
              To accurately track player movement, the engine needs to understand the camera's perspective. 
              Click on your video frame to map the <strong>exactly 7 points</strong> shown on the reference court map.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 p-6 gap-8">
            
            <div className="lg:col-span-2 space-y-4">
              <div className="flex justify-between items-center bg-gray-50 p-3 rounded-lg border">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-gray-700">Plotted:</span>
                  <span className={`px-3 py-1 text-sm font-bold rounded-full transition-colors ${points.length === 7 ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                    {points.length} / 7
                  </span>
                </div>
                <button 
                  onClick={onUndoPoint} 
                  disabled={points.length === 0}
                  className="flex items-center gap-2 px-4 py-1.5 text-sm bg-white hover:bg-gray-100 border disabled:opacity-50 disabled:cursor-not-allowed rounded-md font-medium transition shadow-sm text-gray-700"
                >
                  <UndoIcon /> Undo Last Point
                </button>
              </div>

              <div className="relative border-4 border-gray-200 rounded-xl overflow-hidden bg-black w-full shadow-inner cursor-crosshair group hover:border-blue-300 transition-colors">
                {setupFrameUrl ? (
                  <div className="relative w-full">
                    <img src={setupFrameUrl} className="w-full h-auto block select-none" alt="Setup Frame" />
                    <canvas ref={setUpCanvasRef} className="absolute inset-0 w-full h-full" onClick={onPointPlot} />
                  </div>
                ) : (
                  <div className="flex items-center justify-center aspect-video text-white">
                    <LoaderIcon /> <span className="ml-2 font-medium">Extracting Frame...</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col space-y-6">
              
              <div>
                <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">Reference Map</h3>
                <div className="relative border-2 rounded-xl overflow-hidden bg-white shadow-sm" style={{ aspectRatio: '1740/928' }}>
                  <CourtDisplay isPlotting={true} points={courtPts} backgroundColor="#f8fafc" />
                </div>
              </div>

              <div className="bg-blue-50 p-5 rounded-xl border border-blue-100 flex-1">
                <h4 className="font-bold text-blue-800 mb-3 flex items-center gap-2">
                  <AlertIcon /> Instructions
                </h4>
                <ol className="list-decimal list-inside text-sm text-blue-900 space-y-3 font-medium">
                  <li>Look at point <strong>#1</strong> on the Reference Map.</li>
                  <li>Click the exact corresponding location on your Video Frame.</li>
                  <li>Repeat this process in numerical order for all <strong>7 points</strong>.</li>
                  <li>Use the Undo button if you misclick.</li>
                </ol>
              </div>

              <div className="pt-2 flex gap-3 mt-auto">
                <button 
                  onClick={() => { setStatus("idle"); reset(); }} 
                  className="flex-1 py-3 border-2 border-gray-200 rounded-xl hover:bg-gray-50 transition font-bold text-gray-600"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleStartAnalysis} 
                  className={`flex-1 py-3 text-white rounded-xl font-bold transition shadow-lg ${points.length === 7 ? 'bg-green-600 hover:bg-green-700 shadow-green-200 hover:-translate-y-0.5' : 'bg-gray-300 cursor-not-allowed shadow-none'}`}
                >
                  Start Analysis
                </button>
              </div>

            </div>
          </div>
        </div>
      </div>
    );
  }
  
  if (status === "processing" || status === "done") {
    return (
      <div className="max-w-7xl mx-auto mt-6 px-4 pb-10 animate-in fade-in zoom-in-95 duration-300">
        <div className="bg-white rounded-2xl border shadow-xl overflow-hidden flex flex-col">
          
          <div className="bg-blue-600 p-6 text-white flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-4">
                <h2 className="text-2xl font-bold border-r border-blue-400 pr-4">Analysis Engine</h2>
                {viewMode === 'correction' && (
                  <div className="bg-blue-800/60 text-blue-100 px-4 py-1.5 rounded-lg font-mono text-sm font-semibold flex items-center shadow-inner">
                      FRAME: <span className="ml-2 text-white w-12 text-right">{isVideoLoaded ? getCurrentFrameIndex() : 0}</span>
                  </div>
                )}
            </div>
            
            <div className="flex items-center gap-6">
                {status === 'processing' && (
                    <div className="flex items-center gap-3 border-r border-blue-400 pr-6">
                        <span className="text-sm font-bold text-blue-100 animate-pulse">Syncing... {processingProgress}%</span>
                        <div className="w-32 bg-blue-800 rounded-full h-2.5 overflow-hidden shadow-inner">
                            <div className="bg-green-400 h-full rounded-full transition-all duration-300" style={{ width: `${processingProgress}%` }}></div>
                        </div>
                    </div>
                )}
                
                <div className="flex gap-1 bg-blue-800/50 p-1 rounded-lg border border-blue-700 shadow-inner">
                    <button onClick={() => { setViewMode('correction'); if (videoRef.current) drawRef.current(getCurrentFrameIndex()); }} className={`flex items-center gap-2 px-5 py-2 rounded-md font-bold text-sm transition-all ${viewMode === 'correction' ? 'bg-white text-blue-700 shadow-md' : 'text-blue-100 hover:text-white hover:bg-blue-700/50'}`}>
                        <VideoIcon /> Correction
                    </button>
                    <button onClick={() => setViewMode('dashboard')} className={`flex items-center gap-2 px-5 py-2 rounded-md font-bold text-sm transition-all ${viewMode === 'dashboard' ? 'bg-white text-blue-700 shadow-md' : 'text-blue-100 hover:text-white hover:bg-blue-700/50'}`}>
                        <ChartIcon /> Dashboard
                    </button>
                </div>
            </div>
          </div>

          <div className="p-6 bg-gray-50/30">
            {viewMode === 'dashboard' ? (
              <Dashboard 
                frameDataRef={frameDataRef}
                hiddenIds={hiddenIds}
                idLabels={idLabels}
                fpsRef={fpsRef}
                status={status}
                processingProgress={processingProgress}
                currentFrame={currentFrame}
              />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                <div className="lg:col-span-2 flex flex-col space-y-4">
                  
                  <div className="flex justify-between items-center bg-white p-3 rounded-xl border shadow-sm">
                      <div className="flex gap-2">
                          {[
                              { id: 'select', icon: <EditIcon />, label: 'Rename' },
                              { id: 'switch', icon: <CheckIcon />, label: 'Switch' },
                              { id: 'eraser', icon: <AlertIcon />, label: 'Erase' },
                              { id: 'track', icon: <TrackIcon />, label: 'Track' }
                          ].map(t => (
                              <button 
                                    key={t.id} 
                                    onClick={() => setActiveTool(activeTool === t.id ? null : (t.id as any))}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm transition-all ${activeTool === t.id ? 'bg-blue-100 text-blue-700 border-2 border-blue-600 shadow-sm' : 'bg-gray-50 text-gray-500 hover:bg-gray-100 border-2 border-transparent hover:border-gray-200'}`}
                                  >
                                      {t.icon} {t.label}
                                  </button>
                          ))}
                      </div>
                  </div>

                  <div ref={containerRef} className="relative border-4 border-gray-200 rounded-xl overflow-hidden bg-black w-full flex-1 shadow-inner group hover:border-blue-300 transition-colors">
                    <VideoPlayer
                      ref={videoRef} 
                      src={previewUrl!} 
                      canvasRef={canvasRef}
                      onLoadedMetadata={e => { 
                        canvasRef.current!.width = e.currentTarget.videoWidth; 
                        canvasRef.current!.height = e.currentTarget.videoHeight; 
                        setIsVideoLoaded(true);
                        startLoop(); 
                      }}
                      onPlay={(e) => {
                        if (renamingId) {
                          e.currentTarget.pause();
                          return;
                        }
                        startLoop();
                      }}
                      onSeeked={() => drawRef.current(getCurrentFrameIndex())}
                      fpsref={fpsRef}
                    >
                      {activeTool === 'switch' && (
                          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-blue-600 text-white px-6 py-3 rounded-full shadow-2xl font-bold text-sm flex items-center gap-3 z-50 animate-in slide-in-from-top-4">
                              <AlertIcon />
                              {switchPhase === 'idle' && "Step 1: Click the FIRST player before the mix-up."}
                              {switchPhase === 'select_start' && "Step 2: Click the SECOND player before the mix-up."}
                              {switchPhase === 'seek_end' && "Step 3: Seek forward past the mix-up, then click the FIRST player."}
                              {switchPhase === 'select_end' && "Step 4: Click the SECOND player to complete."}
                              
                              {switchPhase !== 'idle' && (
                                  <button onClick={(e) => { e.stopPropagation(); setSwitchPhase('idle'); setSwitchRangeData({ start_state: [], end_state: [] }); }} className="ml-4 bg-white/20 hover:bg-white/30 text-white px-3 py-1 rounded-full text-xs transition">
                                      Cancel
                                  </button>
                              )}
                          </div>
                      )}
                      {renamingId && (
                        <div 
                          id="rename-popup"
                          className="absolute z-50 bg-white shadow-xl border border-gray-200 p-3 rounded-lg w-56 pointer-events-auto"
                          style={{ left: renamingId.x, top: renamingId.y }}
                          // Just standard stoppers to prevent the canvas from stealing the initial click
                          onPointerDown={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label className="block text-xs font-bold text-gray-800 mb-2">
                            Rename Track {renamingId.id}
                          </label>

                          <input 
                            type="number"
                            autoFocus
                            placeholder="Enter target ID..."
                            className="w-full p-2 border border-gray-300 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500 mb-2 bg-gray-50"
                            onPointerDown={(e) => e.stopPropagation()} // Let user click inside the box
                            onKeyDown={(e) => {
                              e.stopPropagation(); // Stop typing from triggering video hotkeys (like Space to pause)
                              
                              if (e.key === 'Enter') {
                                const newId = parseInt(e.currentTarget.value);
                                if (isNaN(newId)) return;

                                // --- THE STRONG CHECKERS ---
                                // 1. Get everything currently visible on screen
                                const currentFrameDetections = frameDataRef.current.get(currentFrame)?.detections || [];
                                
                                // 2. Check if the ID they typed is already on the screen
                                const isActiveNow = currentFrameDetections.some(d => d.id === newId);
                                
                                // 3. The Block: If it's on screen (and isn't the one they are already editing), abort!
                                if (isActiveNow && newId !== renamingId.id) {
                                   alert(`CRITICAL: Track ${newId} is already active on this frame.\n\nYou cannot merge into a track that is currently on screen. Please use the Eraser tool to delete Track ${newId}'s bounding box first.`);
                                   return;
                                }

                                // If it passes the checks, fire the merge and close the popup
                                handleMergeIds(renamingId.id, newId);
                                setRenamingId(null);
                                setSelectedId(null);
                              }
                            }}
                          />

                          <div className="flex justify-between items-center text-xs text-gray-500 mt-1">
                            <span>Press <kbd className="bg-gray-200 px-1.5 py-0.5 rounded border border-gray-300 font-mono text-[10px] font-bold text-gray-700">Enter</kbd></span>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamingId(null);
                                setSelectedId(null);
                              }}
                              className="text-gray-500 hover:text-gray-800 px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      
                      {/* 2D Radar map */}
                      <div className="absolute top-4 right-4 w-1/4 border-2 border-white/40 rounded-lg shadow-2xl overflow-hidden bg-black/40 backdrop-blur-sm z-40 pointer-events-none">
                        <div className="bg-gray-900/80 text-white text-[10px] uppercase font-bold px-3 py-1.5 flex justify-between items-center tracking-wider border-b border-white/10">
                            <span>Live Radar</span>
                            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                        </div>
                        <div className="relative w-full">
                            <CourtDisplay isPlotting={true} points={mapPts} backgroundColor="transparent" />
                        </div>
                      </div>
                    </VideoPlayer>
                  </div>

                  <div className="mt-2 p-3 bg-white border border-gray-200 rounded-xl flex gap-6 overflow-x-auto shadow-sm items-center min-h-[60px]">
                      {allSeenIds.length === 0 ? (
                          <span className="text-sm text-gray-400 italic">No IDs detected yet...</span>
                      ) : (
                          (() => {
                              // 1. Filter out permanently deleted IDs (your existing logic)
                              const validIds = allSeenIds.filter(id => {
                                  const deleteFrame = hiddenIds[id];
                                  return deleteFrame === undefined || currentFrame < deleteFrame;
                              });

                              // 2. Check the current frame to split them into Active vs Inactive
                              const currentDetections = frameDataRef.current.get(currentFrame)?.detections || [];
                              const activeIds = validIds.filter(id => currentDetections.some(d => d.id === id));
                              const inactiveIds = validIds.filter(id => !currentDetections.some(d => d.id === id));

                              return (
                                  <>
                                      {/* --- ACTIVE SECTION --- */}
                                      <div className="flex items-center gap-2">
                                          <span className="text-xs font-bold text-green-600 uppercase tracking-wider mr-1 whitespace-nowrap">Active:</span>
                                          {activeIds.length === 0 ? (
                                              <span className="text-xs text-gray-400 italic mr-2">None</span>
                                          ) : (
                                              activeIds.map((id) => (
                                                  <button
                                                      key={id}
                                                      onClick={() => setSelectedId(prev => prev === id ? null : id)}
                                                      className={`px-4 py-1.5 rounded-md text-white font-bold text-sm transition-all flex-shrink-0 
                                                          ${selectedId === id ? 'scale-110 ring-2 ring-offset-2 ring-blue-500 shadow-lg' : 'hover:opacity-90 opacity-100'}
                                                      `}
                                                      style={{ backgroundColor: COLORS[id % COLORS.length] }}
                                                  >
                                                      {idLabels[id] || `#${id}`}
                                                  </button>
                                              ))
                                          )}
                                      </div>

                                      {/* --- VISUAL DIVIDER --- */}
                                      <div className="w-px h-8 bg-gray-200 shrink-0"></div>

                                      {/* --- INACTIVE SECTION --- */}
                                      <div className="flex items-center gap-2">
                                          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider mr-1 whitespace-nowrap">Inactive:</span>
                                          {inactiveIds.length === 0 ? (
                                              <span className="text-xs text-gray-400 italic">None</span>
                                          ) : (
                                              inactiveIds.map((id) => (
                                                  <button
                                                      key={id}
                                                      onClick={() => setSelectedId(prev => prev === id ? null : id)}
                                                      className={`px-4 py-1.5 rounded-md text-white font-bold text-sm transition-all flex-shrink-0 
                                                          ${selectedId === id ? 'scale-110 ring-2 ring-offset-2 ring-blue-500 shadow-lg' : 'opacity-60 hover:opacity-100 grayscale-[0.5]'}
                                                      `}
                                                      style={{ backgroundColor: COLORS[id % COLORS.length] }}
                                                  >
                                                      {idLabels[id] || `#${id}`}
                                                  </button>
                                              ))
                                          )}
                                      </div>
                                  </>
                              );
                          })()
                      )}
                  </div>
                </div>

                <div className="border-2 border-gray-200 bg-white rounded-xl shadow-sm flex flex-col h-full max-h-full overflow-hidden">
                  
                  {activeTool === 'track' && (
                      <div className="bg-purple-50 p-5 border-b-2 border-purple-100 animate-in slide-in-from-left-2">
                          <p className="text-xs text-purple-700 font-bold uppercase mb-2 tracking-wider">Target Track ID</p>
                          <div className={`flex items-center bg-white px-4 py-3 rounded-lg border shadow-sm transition-all focus-within:ring-2 ${addingTrackId === null ? 'border-orange-300 ring-orange-100' : 'focus-within:ring-purple-500'}`}>
                              <span className="font-bold text-gray-400 mr-2 text-xl">#</span>
                              <input 
                                  type="number" 
                                  placeholder="Enter ID..."
                                  value={addingTrackId ?? ''} // Show empty string if null
                                  onChange={(e) => setAddingTrackId(e.target.value === '' ? null : Number(e.target.value))}
                                  className="font-mono font-bold text-xl text-purple-900 w-full bg-transparent outline-none"
                                  min="0"
                              />
                          </div>
                          {addingTrackId === null && (
                              <p className="text-[10px] text-orange-600 mt-2 font-bold uppercase">Required: Enter ID or draw box to prompt</p>
                          )}
                      </div>
                  )}
                  
                  <div className="p-5 border-b bg-gray-50 flex justify-between items-center">
                      <h3 className="font-bold text-gray-700 uppercase tracking-wider text-sm">Edit Log</h3>
                      <div className="flex items-center gap-3">
                          <button onClick={handleUndo} disabled={correctionsBatch.length === 0} className={`p-2 rounded-lg transition-colors border ${correctionsBatch.length > 0 ? 'bg-white text-blue-600 hover:bg-blue-50 border-blue-200 shadow-sm' : 'bg-gray-100 text-gray-300 border-transparent cursor-not-allowed'}`} title="Undo Last Action">
                              <UndoIcon />
                          </button>
                          <span className="text-xs font-bold bg-blue-100 text-blue-800 px-3 py-1 rounded-full">{editHistory.length} pending</span>
                      </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-white">
                     {editHistory.length === 0 ? (
                         <div className="flex flex-col items-center justify-center h-full text-gray-400 space-y-3 opacity-60">
                            <AlertIcon />
                            <span className="text-sm font-medium">No edits pending.</span>
                         </div>
                     ) : editHistory.map((edit, i) => (
                         <div key={i} className="bg-gray-50 border border-gray-100 rounded-xl p-3 text-sm shadow-sm flex items-start gap-4 animate-in fade-in slide-in-from-right-4">
                             <div className="bg-blue-100 text-blue-800 font-mono text-xs font-bold px-2 py-1 rounded-md mt-0.5 border border-blue-200">F{edit.frame}</div>
                             <div>
                                 <div className="font-bold text-gray-800">{edit.action}</div>
                                 <div className="text-gray-500 text-xs mt-1 font-medium">{edit.target}</div>
                             </div>
                         </div>
                     ))}
                  </div>

                  <div className="p-5 bg-gray-50 border-t">
                      <button 
                        onClick={onCorrection} 
                        disabled={correctionsBatch.length === 0 || status === 'processing'} 
                        className={`w-full py-3.5 rounded-xl font-bold text-base transition-all ${correctionsBatch.length > 0 && status !== 'processing' ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-200 hover:-translate-y-0.5' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                      >
                        {status === 'processing' ? 'Processing...' : 'Sync Corrections'}
                      </button>
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto mt-20">
      <header className="mb-6"><h2 className="text-2xl font-bold text-center">Video Analysis Engine</h2></header>
      <form onSubmit={handleSubmit(onSetup)} className="bg-white p-10 rounded-2xl border-2 border-dashed border-gray-300 shadow-xl space-y-8 text-center">
        <div className="relative p-10 bg-gray-50 rounded-xl hover:bg-blue-50 transition cursor-pointer group">
          <input {...register("video")} type="file" accept="video/*" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          <div className="text-blue-600 font-bold text-lg">
            {videoFile?.[0] ? videoFile[0].name : "Drop video file here"}
          </div>
          <p className="text-gray-400 text-sm mt-2">Max 2GB • MP4/MOV</p>
        </div>
        <button type="submit" className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold shadow-lg hover:bg-blue-700 hover:-translate-y-1 transition active:translate-y-0">Analyze Footage</button>
      </form>
    </div>
  );
}