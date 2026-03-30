'use client';

import { useState, useMemo, useEffect, useRef } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
// 1. Swap the import
import simpleheat from 'simpleheat';

export default function Dashboard ({
    frameDataRef,
    hiddenIds,
    idLabels,
    fpsRef,
    status,
    processingProgress
}) {
    const [dashboardId, setDashboardId] = useState<number | null>(null);
    const [isCourtLoaded, setIsCourtLoaded] = useState(false);

    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const heatInstanceRef = useRef<any>(null);
    const imageRef = useRef<HTMLImageElement>(null);

    const availableIds = useMemo(() => {
        const ids = new Set<number>();
        frameDataRef.current.forEach(fd => fd.detections.forEach(d => {
            if (!hiddenIds.has(d.id)) ids.add(d.id);
        }));
        return Array.from(ids).sort((a, b) => a - b);
    }, [status, processingProgress, hiddenIds, frameDataRef]);

    const chartData = useMemo(() => {
        if (dashboardId === null || frameDataRef.current.size === 0) return [];
        const data: any[] = [];
        let cumulativeDistance = 0;
        let lastPos: [number, number] | null = null;
        const fps = fpsRef.current || 30;
        const PIXELS_TO_METERS = 28.65 / 1740; 
        const sortedFrames = Array.from(frameDataRef.current.keys()).sort((a, b) => a - b);
        const smoothingWindow = Math.max(1, Math.floor(fps / 3)); 
        let windowQueue: {pos: [number, number], time: number}[] = [];
        
        sortedFrames.forEach((frame) => {
            const frameData = frameDataRef.current.get(frame);
            if (!frameData) return;
            const detIndex = frameData.detections.findIndex(d => d.id === dashboardId);
            if (frameData.mapped_points[detIndex]) {
                const pos = frameData.mapped_points[detIndex];
                const timeInSeconds = frame / fps;
                if (lastPos) {
                    const pixelDist = Math.sqrt(Math.pow(pos[0] - lastPos[0], 2) + Math.pow(pos[1] - lastPos[1], 2));
                    cumulativeDistance += (pixelDist * PIXELS_TO_METERS);
                }
                windowQueue.push({pos, time: timeInSeconds});
                if (windowQueue.length > smoothingWindow) windowQueue.shift(); 
                if (windowQueue.length > 1) {
                    const oldest = windowQueue[0];
                    const newest = windowQueue[windowQueue.length - 1];
                    const windowPixelDist = Math.sqrt(Math.pow(newest.pos[0] - oldest.pos[0], 2) + Math.pow(newest.pos[1] - oldest.pos[1], 2));
                    const timeDiff = newest.time - oldest.time;
                    const currentSpeed = timeDiff > 0 ? (windowPixelDist * PIXELS_TO_METERS / timeDiff) : 0;
                    
                    if (frame % Math.max(1, Math.floor(fps / 3)) === 0) {
                        data.push({
                            time: Number(timeInSeconds.toFixed(1)),
                            distance: Number(cumulativeDistance.toFixed(2)),
                            speed: Number(currentSpeed.toFixed(2)),
                            pos: pos
                        });
                    }
                }
                lastPos = pos;
            }
        });
        return data;
    }, [dashboardId, status, processingProgress, frameDataRef, fpsRef]);


    useEffect(() => {
        if (imageRef.current && imageRef.current.complete) {
            setIsCourtLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (!wrapperRef.current || !canvasRef.current || chartData.length === 0 || !isCourtLoaded) return;
        if (!imageRef.current) return; 

        const { clientWidth, clientHeight } = wrapperRef.current;
        if (clientWidth === 0 || clientHeight === 0) return; 

        canvasRef.current.width = clientWidth;
        canvasRef.current.height = clientHeight;

        if (!heatInstanceRef.current) {
            heatInstanceRef.current = simpleheat(canvasRef.current);
        } else {
            heatInstanceRef.current.resize();
        }

        const { naturalWidth, naturalHeight } = imageRef.current;

        const scaleX = clientWidth / naturalWidth;
        const scaleY = clientHeight / naturalHeight;

        const scaledData = chartData.map(d => [
            Math.floor(d.pos[0] * scaleX), 
            Math.floor(d.pos[1] * scaleY),
            1 
        ]);

        heatInstanceRef.current.data(scaledData);
        heatInstanceRef.current.max(15); 
        heatInstanceRef.current.radius(25, 15); 
        heatInstanceRef.current.draw();

    }, [chartData, isCourtLoaded]);

    return(
        <div className="bg-white rounded-xl shadow-lg border p-6 min-h-[65vh]">
            <header className="mb-8 border-b pb-4">
                <h3 className="text-2xl font-bold text-gray-800">Player Analytics</h3>
            </header>
        
            <div className="flex gap-8">
                <div className="w-64 flex flex-col gap-2">
                    <h4 className="font-bold text-xs uppercase tracking-wider text-gray-500 mb-2">Select Target</h4>
                    <div className="flex flex-wrap gap-2 max-h-[50vh] overflow-y-auto">
                        {availableIds.map(id => (
                            <button key={id} onClick={() => setDashboardId(id)} className={`px-4 py-2 rounded-lg font-bold border-2 transition-all ${dashboardId === id ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600'}`}>
                                {idLabels[id] || `ID ${id}`}
                            </button>
                        ))}
                    </div>
                </div>
            
                <div className="flex-1 space-y-8">
                    {!dashboardId ? (
                        <div className="h-64 flex items-center justify-center border-2 border-dashed rounded-2xl bg-gray-50 text-gray-400">Select a Player ID</div>
                    ) : (
                    <>
                        {/* Speed Chart */}
                        <div className="bg-white border rounded-xl p-6 shadow-sm">
                            <h4 className="font-bold text-gray-800 mb-4">Estimated Speed</h4>
                            <div className="h-64 w-full">
                                <ResponsiveContainer>
                                    <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 20 }}>
                                        <defs>
                                            <linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                        <XAxis dataKey="time" type="number" tick={{fill: '#9ca3af', fontSize: 12}} tickLine={false} axisLine={false} label={{ value: 'Time (s)', position: 'bottom', offset: 0, fill: '#6b7280', fontSize: 12, fontWeight: 600 }} />
                                        <YAxis tick={{fill: '#9ca3af', fontSize: 12}} tickLine={false} axisLine={false} label={{ value: 'Speed (m/s)',angle: -90,  position: 'insideLeft', offset: -10, fill: '#6b7280', fontSize: 12, fontWeight: 600 }} />
                                        <RechartsTooltip />
                                        <Area type="monotone" dataKey="speed" stroke="#3b82f6" strokeWidth={3} fill="url(#colorSpeed)" />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
            
                        {/* Distance Chart */}
                        <div className="bg-white border rounded-xl p-6 shadow-sm">
                            <h4 className="font-bold text-gray-800 mb-4">Cumulative Distance</h4>
                            <div className="h-64 w-full">
                                <ResponsiveContainer>
                                    <LineChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 20 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                        <XAxis dataKey="time" type="number" tick={{fill: '#9ca3af', fontSize: 12}} tickLine={false} axisLine={false} label={{ value: 'Time (s)', position: 'bottom', offset: 0, fill: '#6b7280', fontSize: 12, fontWeight: 600 }} />
                                        <YAxis tick={{fill: '#9ca3af', fontSize: 12}} tickLine={false} axisLine={false} label={{ value: 'Distance (m)', angle: -90, position: 'insideLeft', offset: -10, fill: '#6b7280', fontSize: 12, fontWeight: 600 }} />
                                        <RechartsTooltip />
                                        <Line type="monotone" dataKey="distance" stroke="#10b981" strokeWidth={3} dot={false} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        <div className="bg-white border rounded-xl p-6 shadow-sm">
                            <h4 className="font-bold text-gray-800 mb-4">Player HeatMap</h4>
                            
                            <div ref={wrapperRef} className="relative w-full aspect-[1740/928] mx-auto overflow-hidden rounded-lg border border-gray-200">
                                <img 
                                    ref={imageRef} 
                                    src="/mpl_nba_court.png" 
                                    alt="Basketball Court" 
                                    className="w-full h-full object-fill absolute inset-0 z-0"
                                    onLoad={() => setIsCourtLoaded(true)} 
                                />
                                
                                <canvas 
                                    ref={canvasRef} 
                                    className="absolute inset-0 z-10 pointer-events-none w-full h-full" 
                                />
                            </div>
                        </div>
                    </>
                    )}
                </div>
            </div>
        </div>
    );
}