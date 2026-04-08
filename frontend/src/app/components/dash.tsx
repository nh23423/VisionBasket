'use client';

import { useState, useMemo, useEffect, useRef } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import simpleheat from 'simpleheat';

const SpeedIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>;
const DistanceIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>;
const ChartIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>;
export default function Dashboard ({
    frameDataRef,
    hiddenIds,
    idLabels,
    fpsRef,
    status,
    processingProgress,
    currentFrame
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
            const deleteStartFrame = hiddenIds[d.id];
            const isVisible = deleteStartFrame === undefined || currentFrame < deleteStartFrame;

            if (isVisible) {
                ids.add(d.id);
            }

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

    const topSpeed = chartData.length > 0 ? Math.max(...chartData.map(d => d.speed)).toFixed(1) : "0.0";
    const totalDistance = chartData.length > 0 ? chartData[chartData.length - 1].distance.toFixed(1) : "0.0";


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

    }, [chartData, isCourtLoaded, dashboardId]);

    return(
        <div className="flex flex-col h-full gap-6 max-h-[75vh] overflow-y-auto pr-2 pb-4">
            
            {/* TOP CONTROL BAR: Target Selection & Hero Metrics */}
            <div className="bg-white rounded-2xl shadow-sm border p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                
                {/* Target Selector */}
                <div className="flex-1 w-full">
                    <h4 className="font-bold text-xs uppercase tracking-wider text-gray-500 mb-3">Target Profile</h4>
                    <div className="flex flex-wrap gap-2">
                        {availableIds.length === 0 ? (
                            <span className="text-sm text-gray-400 italic">No targets available.</span>
                        ) : availableIds.map(id => (
                            <button 
                                key={id} 
                                onClick={() => setDashboardId(id)} 
                                className={`px-4 py-2 rounded-xl font-bold text-sm transition-all border-2 shadow-sm ${dashboardId === id ? 'border-blue-600 bg-blue-600 text-white shadow-blue-200' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}
                            >
                                {idLabels[id] || `ID ${id}`}
                            </button>
                        ))}
                    </div>
                </div>

                {dashboardId && (
                    <div className="flex gap-4 md:border-l md:pl-6 w-full md:w-auto">
                        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex-1 md:w-40 flex flex-col justify-center">
                            <div className="flex items-center gap-2 text-blue-600 mb-1">
                                <SpeedIcon />
                                <span className="font-bold text-xs uppercase tracking-wider">Top Speed</span>
                            </div>
                            <div className="text-2xl font-black text-gray-800">{topSpeed} <span className="text-sm text-gray-500 font-bold">m/s</span></div>
                        </div>
                        <div className="bg-green-50 border border-green-100 rounded-xl p-4 flex-1 md:w-40 flex flex-col justify-center">
                            <div className="flex items-center gap-2 text-green-600 mb-1">
                                <DistanceIcon />
                                <span className="font-bold text-xs uppercase tracking-wider">Distance</span>
                            </div>
                            <div className="text-2xl font-black text-gray-800">{totalDistance} <span className="text-sm text-gray-500 font-bold">m</span></div>
                        </div>
                    </div>
                )}
            </div>
        
            {/* CHARTS GRID */}
            {!dashboardId ? (
                <div className="flex-1 bg-white border-2 border-dashed border-gray-200 rounded-2xl flex flex-col items-center justify-center min-h-[400px] text-gray-400">
                    <ChartIcon />
                    <span className="mt-4 font-bold text-lg">Select a player to view analytics</span>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    
                    {/* Speed Chart */}
                    <div className="bg-white border rounded-2xl p-6 shadow-sm">
                        <h4 className="font-bold text-gray-800 mb-6">Velocity Profile</h4>
                        <div className="h-56 w-full">
                            <ResponsiveContainer>
                                <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                                    <XAxis dataKey="time" type="number" tick={{fill: '#9ca3af', fontSize: 11}} tickLine={false} axisLine={false} />
                                    <YAxis tick={{fill: '#9ca3af', fontSize: 11}} tickLine={false} axisLine={false} />
                                    <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                    <Area type="monotone" dataKey="speed" stroke="#3b82f6" strokeWidth={3} fill="url(#colorSpeed)" />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
        
                    {/* Distance Chart */}
                    <div className="bg-white border rounded-2xl p-6 shadow-sm">
                        <h4 className="font-bold text-gray-800 mb-6">Cumulative Distance</h4>
                        <div className="h-56 w-full">
                            <ResponsiveContainer>
                                <LineChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                                    <XAxis dataKey="time" type="number" tick={{fill: '#9ca3af', fontSize: 11}} tickLine={false} axisLine={false} />
                                    <YAxis tick={{fill: '#9ca3af', fontSize: 11}} tickLine={false} axisLine={false} />
                                    <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                    <Line type="monotone" dataKey="distance" stroke="#10b981" strokeWidth={3} dot={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Heatmap (Spans full width on bottom) */}
                    <div className="lg:col-span-2 bg-white border rounded-2xl p-6 shadow-sm">
                        <h4 className="font-bold text-gray-800 mb-4">Positional Heatmap</h4>
                        <div ref={wrapperRef} className="relative w-full aspect-[1740/928] mx-auto overflow-hidden rounded-xl border border-gray-200 shadow-inner bg-gray-50">
                            <img 
                                ref={imageRef} 
                                src="/mpl_nba_court.png" 
                                alt="Basketball Court" 
                                className="w-full h-full object-fill absolute inset-0 z-0 opacity-80 mix-blend-multiply"
                                onLoad={() => setIsCourtLoaded(true)} 
                            />
                            <canvas 
                                ref={canvasRef} 
                                className="absolute inset-0 z-10 pointer-events-none w-full h-full" 
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}