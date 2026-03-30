'use client';

import { zodResolver } from "@hookform/resolvers/zod";
import { SubmitHandler, useForm } from "react-hook-form";
import { z } from "zod";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { APIService, Detection, SingleCorrection, PlayerState, SwitchRangeCorrection} from "../services/api.service";
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

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | 'eraser' | 'switch' | 'track'>('select');
  const [firstSelectedId, setFirstSelectedId] = useState<number | null>(null);
  const [idLabels, setIdLabels] = useState<Record<number, string>>({});
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  const [renamingId, setRenamingId] = useState<{id: number, x: number, y: number} | null>(null);
  const [fileUploadProgress, setFileUploadProgress] = useState(0);
  
  // Correction Tracking
  const [correctionsBatch, setCorrectionsBatch] = useState<(SingleCorrection | SwitchRangeCorrection)[]>([]);
  const [editHistory, setEditHistory] = useState<{frame: number, action: string, target: string}[]>([]);

  const [switchPhase, setSwitchPhase] = useState<'idle' | 'select_start' | 'seek_end' | 'select_end'>('idle');
  const [switchRangeData, setSwitchRangeData] = useState<{
      start_frame?: number,
      end_frame?: number,  
      start_state: PlayerState[], 
      end_state: PlayerState[]
  }>({ start_state: [], end_state: [] });
  
  // Manual Tracking State
  const activeCustomTrackIdRef = useRef<number>(90000);
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
  const [mapPts, setMapPts] = useState<[number, number][]>([]);

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
            fd.detections = fd.detections.filter(d => d.id !== trackId);
            fd.detections.push({ id: trackId, bbox: ibbox as [number,number,number,number], conf: 1, isInterpolated: true });
        }
    };

    const idx = trackKeyframes.findIndex(k => k.frame === newFrame);
    if(trackKeyframes[idx - 1]) applyInterp(trackKeyframes[idx - 1], trackKeyframes[idx]);
    if(trackKeyframes[idx + 1]) applyInterp(trackKeyframes[idx], trackKeyframes[idx + 1]);

    let fd = frameDataRef.current.get(newFrame);
    if(!fd) { fd = { detections: [], mapped_points: [] }; frameDataRef.current.set(newFrame, fd); }
    fd.detections = fd.detections.filter(d => d.id !== trackId);
    fd.detections.push({ id: trackId, bbox: newBbox as [number,number,number,number], conf: 1, isManualKeyframe: true });
  }, []);

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
      if (hiddenIds.has(id)) return;
      const [x1, y1, x2, y2] = bbox;
      
      const isBlockedAnchor = 
          (activeTool === 'switch' && switchPhase === 'select_start' && switchRangeData.start_state[0]?.track_id === id && frameIndex === switchRangeData.start_frame) ||
          (activeTool === 'switch' && switchPhase === 'select_end' && switchRangeData.end_state[0]?.track_id === id && frameIndex === switchRangeData.end_frame);

      const isSelected = 
          id === overrideId || 
          (activeTool === 'switch' && switchRangeData.start_state.some(s => s.track_id === id && frameIndex === switchRangeData.start_frame)) ||
          (activeTool === 'switch' && switchRangeData.end_state.some(s => s.track_id === id && frameIndex === switchRangeData.end_frame));
          
      const isPending = pendingIds.has(id);
      const labelText = idLabels[id] || `ID ${id}`;
      
      let color = '#00FF00'; 
      if (isPending) color = '#9ca3af'; // GRAY out pending IDs
      else if (isBlockedAnchor) color = '#FF0000'; // Blocked first selection gets highlighted RED
      else if (isSelected) color = '#FFD700'; // General active selection gets GOLD
      else if (isManualKeyframe) color = '#ec4899'; 
      else if (isInterpolated) color = '#a855f7'; 

      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected || isBlockedAnchor || isManualKeyframe ? 4 : 2;
      
      // Dashed lines for pending boxes
      if (isPending) ctx.setLineDash([5, 5]);
      else ctx.setLineDash([]);

      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      
      ctx.font = 'bold 24px sans-serif'; 
      const textMetrics = ctx.measureText(labelText);
      ctx.fillStyle = color;
      ctx.fillRect(x1, y1 - 30, textMetrics.width + 12, 30);
      ctx.fillStyle = (isManualKeyframe || isInterpolated || isPending) ? '#FFFFFF' : '#000000';
      ctx.fillText(labelText, x1 + 6, y1 - 6);
      
      ctx.setLineDash([]); // reset
    });
  }, [selectedId, firstSelectedId, idLabels, hiddenIds, activeTool, switchPhase, switchRangeData, correctionsBatch]);

  const drawFrameIndex = useCallback((frameIndex: number) => {
    renderFrameWithSelection(frameIndex, selectedId);
    setMapPts(frameDataRef.current.get(frameIndex)?.mapped_points ?? []);
  }, [selectedId, renderFrameWithSelection]);

  const drawRef = useRef(drawFrameIndex);
  useEffect(() => { drawRef.current = drawFrameIndex; }, [drawFrameIndex]);

  // Handle Playback/Seeking
  const onVideoFrameCallback = useCallback((now: number, metadata: any) => {
    if (videoRef.current) drawRef.current(Math.round(metadata.mediaTime * fpsRef.current));
    if (videoRef.current && 'requestVideoFrameCallback' in videoRef.current) {
        requestRef.current = (videoRef.current as any).requestVideoFrameCallback(onVideoFrameCallback);
    }
  }, []);

  const startLoop = useCallback(() => {
    const video = videoRef.current;
    if (video && 'requestVideoFrameCallback' in video) {
        if (requestRef.current) (video as any).cancelVideoFrameCallback(requestRef.current);
        requestRef.current = (video as any).requestVideoFrameCallback(onVideoFrameCallback);
    }
  }, [onVideoFrameCallback]);

  // Synchronize Canvas with UI changes
  useEffect(() => {
    const video = videoRef.current;
    if (video && video.paused) {
      drawRef.current(Math.round(video.currentTime * fpsRef.current));
    }
  }, [firstSelectedId, selectedId, hiddenIds, idLabels, activeTool, switchPhase, switchRangeData, drawFrameIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || (status !== 'done' && status !== 'processing') || viewMode !== 'correction') return;

    const onPointerDown = (e: PointerEvent) => {
        const { x, y, scaleX, scaleY, offsetX, offsetY } = getMousePos(e.clientX, e.clientY, canvas);
        const frameIndex = Math.round(video.currentTime * fpsRef.current);

        if (activeTool === 'track') {
            isDrawingRef.current = true;
            drawStartRef.current = { x, y };
            drawCurrentRef.current = { x, y };
            return;
        } 

        const currentDetections = frameDataRef.current.get(frameIndex)?.detections ?? [];
        
        const hits = currentDetections.filter(d => 
            !hiddenIds.has(d.id) &&
            x >= d.bbox[0] && x <= d.bbox[2] && 
            y >= d.bbox[1] && y <= d.bbox[3]
        );
        
        hits.sort((a, b) => {
            const areaA = (a.bbox[2]-a.bbox[0]) * (a.bbox[3]-a.bbox[1]);
            const areaB = (b.bbox[2]-b.bbox[0]) * (b.bbox[3]-b.bbox[1]);
            return areaA - areaB;
        });
        
        const clickedId = hits.length > 0 ? hits[0].id : null;

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
            setHiddenIds(prev => new Set(prev).add(clickedId));
            setEditHistory(prev => [{ frame: frameIndex, action: 'Deleted', target: `ID ${clickedId}` }, ...prev]);
            setCorrectionsBatch(prev => [...prev, { frame_idx: frameIndex, track_id: clickedId, action: "DELETE" }]);

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
            setSelectedId(clickedId);
            if (hits.length > 0) {
              const screenX = (hits[0].bbox[0] / scaleX) + offsetX;
              const screenY = (hits[0].bbox[1] / scaleY) + offsetY;
              setRenamingId({ id: clickedId!, x: screenX, y: screenY });
            } else {
              setRenamingId(null);
            }
        }
    };

    const onPointerMove = (e: PointerEvent) => {
        if (!isDrawingRef.current || activeTool !== 'track') return;
        const { x, y } = getMousePos(e.clientX, e.clientY, canvas);
        drawCurrentRef.current = { x, y };
        
        const frameIndex = Math.round(video.currentTime * fpsRef.current);
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
        const frameIndex = Math.round(video.currentTime * fpsRef.current);
        
        const start = drawStartRef.current;
        const end = drawCurrentRef.current;
        const x1 = Math.min(start.x, end.x); const y1 = Math.min(start.y, end.y);
        const x2 = Math.max(start.x, end.x); const y2 = Math.max(start.y, end.y);
        
        if (x2 - x1 > 15 && y2 - y1 > 15) { 
            handleInterpolate(activeCustomTrackIdRef.current, frameIndex, [x1, y1, x2, y2]);
            setEditHistory(prev => [{ frame: frameIndex, action: 'Track Keyframe', target: `ID ${activeCustomTrackIdRef.current}` }, ...prev]);
            setCorrectionsBatch(prev => [...prev, { frame_idx: frameIndex, track_id: activeCustomTrackIdRef.current, action: "TRACK", new_box: [x1, y1, x2, y2] }]);
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
  }, [status, activeTool, switchPhase, switchRangeData, hiddenIds, idLabels, handleInterpolate, correctionsBatch, viewMode]);


const handleUndo = () => {
    if (correctionsBatch.length === 0) return;
    const lastCorrection = correctionsBatch[correctionsBatch.length - 1];
    
    if (lastCorrection.action === 'DELETE') {
        setHiddenIds(prev => { const n = new Set(prev); n.delete(lastCorrection.track_id); return n; });
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
    if (videoRef.current) drawRef.current(Math.round(videoRef.current.currentTime * fpsRef.current));
  };


  // --- BACKEND API LOGIC ---
//   const onSetup = async () => {
//     setStatus("setup"); frameDataRef.current.clear(); setPoints([]);
//     const formData = new FormData(); formData.append("video", videoFile[0]);
//     const result = await APIService.upload(formData);
//     taskIdRef.current = result.task_id; setCourtPts(result.setup_pts); setSetupFrameUrl(result.frame);
//   };

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
          if (data.status === "started") fpsRef.current = data.fps ?? 30;
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
          if (data.status === "started") fpsRef.current = data.fps ?? 30;
          else if (data.status === "processing") {
            setProcessingProgress(data.progress || 0);
            data.frames?.forEach(f => frameDataRef.current.set(f.frame_id, { detections: f.detections, mapped_points: f.mapped_points }));
          } else if (data.status === "completed") {
            wsRef.current?.close(); 
            setStatus("done"); 
            setProcessingProgress(100); 
            if (videoRef.current && viewMode === 'correction') {
                drawRef.current(Math.round(videoRef.current.currentTime * fpsRef.current));
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

  const onPointPlot = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = setUpCanvasRef.current; const img = canvas?.previousElementSibling as HTMLImageElement;
    if (!canvas || !img) return;
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const newPoints: [number, number][] = [...points, [x, y]];
    setPoints(newPoints);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / canvas.offsetWidth;
    newPoints.forEach((pt, i) => {
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 8 * scale, 0, Math.PI * 2); 
        ctx.fillStyle = '#00FF00'; ctx.fill();
        ctx.font = `bold ${10 * scale}px sans-serif`; ctx.fillStyle = '#000000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; 
        ctx.fillText(`${i + 1}`, pt[0], pt[1]); 
    });
  };

  if (status === "setup") {
    return(
      <div className="max-w-5xl mx-auto mt-10">
        <div className="bg-white p-6 rounded-xl border shadow-sm space-y-4">
          <header className="border-b pb-4"><h2 className="text-2xl font-bold">Court Keypoint references</h2></header>
          <div className="relative border-2 rounded-lg overflow-hidden bg-white aspect-video"><CourtDisplay isPlotting={true} points={courtPts} backgroundColor="#f8fafc"/></div>
        </div>
        <div className="bg-white p-6 rounded-xl border shadow-sm space-y-6 mt-6 animate-in fade-in zoom-in-95 duration-300">
          <header className="border-b pb-4"><h2 className="text-2xl font-bold">Label key court points</h2></header>
          <div className="relative border-2 border-blue-500 rounded-lg overflow-hidden bg-black w-full">
            {setupFrameUrl ? (
              <div className="relative w-full">
                <img src={setupFrameUrl} className="w-full h-auto block" alt="Setup Frame" />
                <canvas ref={setUpCanvasRef} className="absolute inset-0 w-full h-full cursor-crosshair" onClick={onPointPlot} />
              </div>
            ) : <div className="flex items-center justify-center aspect-video text-white"><LoaderIcon /> <span className="ml-2">Loading...</span></div>}
          </div>
          <div className="flex justify-between items-center pt-4">
            <button onClick={() => { setStatus("idle"); reset(); }} className="px-6 py-2.5 border rounded-lg hover:bg-gray-50 transition font-medium">Back</button>
            <button onClick={onSubmit} className="px-8 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium">Start Analysis</button>
          </div>
        </div>
      </div>
    );
  }
  
  if (status === "processing" || status === "done") {
    return (
      <div className="max-w-7xl mx-auto mt-4 space-y-4 px-4 pb-10">
        
        {/* TOP TOOLBAR */}
        <div className="bg-white rounded-xl shadow-sm border p-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-gray-800 border-r pr-4 mr-2">Engine</h2>
                {viewMode === 'correction' && (
                  <div className="bg-gray-100 text-gray-700 px-4 py-1.5 rounded-lg font-mono text-sm font-semibold flex items-center shadow-inner">
                      FRAME: <span className="ml-2 text-blue-600 w-12 text-right">{videoRef.current ? Math.round(videoRef.current.currentTime * fpsRef.current) : 0}</span>
                  </div>
                )}
            </div>
            
            <div className="flex items-center gap-4">
                {status === 'processing' && (
                    <div className="flex items-center gap-3 border-r pr-4">
                        <span className="text-sm font-semibold text-gray-500 animate-pulse">Syncing... {processingProgress}%</span>
                        <div className="w-32 bg-gray-200 rounded-full h-2 overflow-hidden"><div className="bg-blue-600 h-2 rounded-full" style={{ width: `${processingProgress}%` }}></div></div>
                    </div>
                )}
                
                {viewMode === 'correction' && (
                    <div className="flex gap-2">
                        {[
                            { id: 'select', icon: <EditIcon />, label: 'Select' },
                            { id: 'switch', icon: <CheckIcon />, label: 'Switch' },
                            { id: 'eraser', icon: <AlertIcon />, label: 'Erase' },
                            { id: 'track', icon: <TrackIcon />, label: 'Track' }
                        ].map(t => (
                            <button key={t.id} onClick={() => setActiveTool(t.id as any)} className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all ${activeTool === t.id ? 'bg-blue-600 text-white shadow-md shadow-blue-200' : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border'}`}>
                                {t.icon} {t.label}
                            </button>
                        ))}
                    </div>
                )}

                <div className="flex gap-1 ml-4 bg-gray-100 p-1 rounded-lg border shadow-inner">
                    <button onClick={() => { setViewMode('correction'); if (videoRef.current) drawRef.current(Math.round(videoRef.current.currentTime * fpsRef.current)); }} className={`flex items-center gap-2 px-4 py-1.5 rounded-md font-bold text-sm transition-all ${viewMode === 'correction' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                        <VideoIcon /> Correction
                    </button>
                    <button onClick={() => setViewMode('dashboard')} className={`flex items-center gap-2 px-4 py-1.5 rounded-md font-bold text-sm transition-all ${viewMode === 'dashboard' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                        <ChartIcon /> Dashboard
                    </button>
                </div>
            </div>
        </div>

        {viewMode === 'dashboard' ? (
          <Dashboard 
            frameDataRef={frameDataRef}
            hiddenIds={hiddenIds}
            idLabels={idLabels}
            fpsRef={fpsRef}
            status={status}
            processingProgress={processingProgress}
         />
        ) : (
          <div className="flex gap-4 items-start h-[65vh]">
            {/* VIDEO CONTAINER */}
            <div ref={containerRef} className="relative w-full h-full bg-black rounded-lg border shadow-inner flex flex-col">
              
              <VideoPlayer
                ref={videoRef} 
                src={previewUrl!} 
                canvasRef={canvasRef}
                onLoadedMetadata={e => { 
                  canvasRef.current!.width = e.currentTarget.videoWidth; 
                  canvasRef.current!.height = e.currentTarget.videoHeight; 
                  startLoop(); 
                }}
                onPlay={startLoop} 
                onSeeked={() => drawRef.current(Math.round(videoRef.current!.currentTime * fpsRef.current))}
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
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSwitchPhase('idle');
                                    setSwitchRangeData({ start_state: [], end_state: [] });
                                }} 
                                className="ml-4 bg-white/20 hover:bg-white/30 text-white px-3 py-1 rounded-full text-xs transition"
                            >
                                Cancel
                            </button>
                        )}
                    </div>
                )}
                {renamingId && activeTool === 'select' && (
                  <div className="absolute z-50 bg-white shadow-2xl rounded-lg border p-1.5 flex items-center transform -translate-x-1/2 -translate-y-[120%]" style={{ left: `${renamingId.x}px`, top: `${renamingId.y}px` }}>
                    <input autoFocus className="text-sm font-bold px-2 py-1 outline-none w-28 text-center" value={idLabels[renamingId.id] || ''} placeholder={`#${renamingId.id}`} onChange={e => setIdLabels(prev => ({...prev, [renamingId.id]: e.target.value}))} onKeyDown={e => e.key === 'Enter' && setRenamingId(null)} />
                    <button onClick={() => setRenamingId(null)} className="p-1 bg-green-100 text-green-700 hover:bg-green-200 rounded-md transition"><CheckIcon /></button>
                  </div>
                )}
                
                <div className="absolute top-4 right-4 w-1/4 border-2 border-white/30 rounded-lg shadow-2xl overflow-hidden bg-black/50 backdrop-blur-sm z-40 pointer-events-none">
                  <div className="bg-gray-900/80 text-white text-[10px] uppercase font-bold px-2 py-1 flex justify-between tracking-wider"><span>Live Radar</span><span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span></div>
                  <div className="relative w-full" style={{ paddingTop: '57.65%' }}><div className="absolute inset-0"><CourtDisplay isPlotting={true} points={mapPts} backgroundColor="transparent" /></div></div>
                </div>
              </VideoPlayer>

            </div>

            {/* TRACK CORRECTION */}
            <div className="w-80 bg-white rounded-xl shadow-lg border flex flex-col h-full overflow-hidden">
              {activeTool === 'track' && (
                  <div className="bg-purple-50 p-4 border-b border-purple-100">
                      <p className="text-xs text-purple-700 font-bold uppercase mb-2 tracking-wider">Active Custom Track</p>
                      <div className="flex items-center justify-between bg-white px-3 py-2 rounded-md border shadow-sm">
                          <span className="font-mono font-bold text-lg text-purple-900">#{activeCustomTrackIdRef.current}</span>
                          <button onClick={() => activeCustomTrackIdRef.current += 1} className="text-xs bg-purple-600 hover:bg-purple-700 text-white px-2 py-1 rounded transition">New Target +</button>
                      </div>
                  </div>
              )}
              
              <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
                  <h3 className="font-bold text-gray-800">Edit History</h3>
                  <div className="flex items-center gap-2">
                      <button onClick={handleUndo} disabled={correctionsBatch.length === 0} className={`p-1.5 rounded-md transition-colors ${correctionsBatch.length > 0 ? 'text-blue-600 hover:bg-blue-100' : 'text-gray-300 cursor-not-allowed'}`} title="Undo Last Action">
                          <UndoIcon />
                      </button>
                      <span className="text-xs font-bold bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{editHistory.length}</span>
                  </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-50/50">
                 {editHistory.length === 0 ? (
                     <div className="text-center text-gray-400 text-sm mt-10 italic">No manual edits made yet.</div>
                 ) : editHistory.map((edit, i) => (
                     <div key={i} className="bg-white border rounded-lg p-2.5 text-sm shadow-sm flex items-start gap-3 animate-in fade-in slide-in-from-right-4">
                         <div className="bg-blue-100 text-blue-800 font-mono text-xs px-1.5 py-0.5 rounded mt-0.5">F{edit.frame}</div>
                         <div>
                             <div className="font-bold text-gray-800">{edit.action}</div>
                             <div className="text-gray-500 text-xs mt-0.5">{edit.target}</div>
                         </div>
                     </div>
                 ))}
              </div>

              <div className="p-4 bg-white border-t shadow-[0_-4px_6px_-1px_rgb(0,0,0,0.05)]">
                  <button 
                    onClick={onCorrection} 
                    disabled={correctionsBatch.length === 0 || status === 'processing'} 
                    className={`w-full py-3 rounded-lg font-bold transition-all ${correctionsBatch.length > 0 && status !== 'processing' ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-200' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                  >
                    {status === 'processing' ? 'Processing...' : 'Push Corrections'}
                  </button>
              </div>
            </div>
          </div>
        )}
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