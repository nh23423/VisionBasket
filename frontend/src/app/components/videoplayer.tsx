'use client';

import { useRef, useState, useEffect } from 'react';
import {
    FaPlay, FaPause, FaStop, FaExpand, FaCompress, FaVolumeUp, FaVolumeMute,
} from 'react-icons/fa';

export default function VideoPlayer({ 
    src, 
    children,
    className, 
    canvasRef,
    handleCanvasClick,
    onLoadedMetadata, 
    onPlay, 
    onSeeked,
    fpsref, 
    ref,
    ...props 
}) {

    const internalRef = useRef(null);
    const videoRef = ref || internalRef; 
    const playerContainerRef = useRef(null);
    
    const intervalRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [progress, setProgress] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [totalTime, setTotalTime] = useState(0);

    const formatTime = (time: number) => {
        if (isNaN(time)) return "00:00";
        const m = Math.floor(time / 60);
        const s = Math.floor(time % 60);
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    const updateProgress = () => {
        if (videoRef.current) {
            const value = (videoRef.current.currentTime / videoRef.current.duration) * 100;
            setCurrentTime(videoRef.current.currentTime)
            setProgress(value);
        }
    };

    useEffect(() => {
        const video = videoRef.current;

        const handleVideoEnd = () => {
            setIsPlaying(false);
            setCurrentTime(totalTime);
            setProgress(0);
            stopProgressLoop();
        };

        if (video) {
            video.addEventListener('ended', handleVideoEnd);
        }

        return () => {
            if (video) {
                video.removeEventListener('ended', handleVideoEnd);
            }
            stopProgressLoop();
        };
    }, [videoRef]);

     // Keyboard navigation
    useEffect(() => {

        const handleKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        const video = videoRef.current;
        if (!video) return;
        // Calculated the duration of each frame based on current fps 
        // Time is the official playback position of videos
        const frameDuration = 1 / fpsref.current;
        if (e.key === 'ArrowLeft') {
            e.preventDefault(); 
            video.pause(); 
            setIsPlaying(false);
            const time = Math.max(0, video.currentTime - frameDuration);
            const seekTo = ( video.currentTime / videoRef.current.duration) *  100;
            video.currentTime = time
            setCurrentTime(time)
            setProgress(seekTo);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault(); 
            video.pause(); 
            setIsPlaying(false)
            const time =  Math.min(video.duration, video.currentTime + frameDuration);
            const seekTo = ( video.currentTime / videoRef.current.duration) *  100;
            video.currentTime = time
            setCurrentTime(time)
            setProgress(seekTo);
        } else if (e.key === ' ') {
                e.preventDefault();
                togglePlayPause();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const startProgressLoop = () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => {
            updateProgress();
        }, 1000);
    };

    const stopProgressLoop = () => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
    };

    const togglePlayPause = () => {
        if (videoRef.current) {
            if (videoRef.current.paused) {
                videoRef.current.play();
                setIsPlaying(true);
                startProgressLoop();
            } else {
                videoRef.current.pause();
                setIsPlaying(false);
                stopProgressLoop();
            }
        }
    };

    const handleSeek = (event) => {
        const seekTo = (event.target.value / 100) * videoRef.current.duration;
        videoRef.current.currentTime = seekTo;
        setProgress(event.target.value);
        setCurrentTime(seekTo);
    };

    const toggleMute = () => {
        const currentVolume = videoRef.current.volume;
        if (currentVolume > 0) {
            videoRef.current.volume = 0;
            setVolume(0);
            setIsMuted(true);
        } else {
            videoRef.current.volume = 1;
            setVolume(1);
            setIsMuted(false);
        }
    };

    const handleVolumeChange = (event) => {
        const newVolume = event.target.value;
        videoRef.current.volume = newVolume;
        setVolume(newVolume);
        setIsMuted(newVolume === 0);
    };

    const toggleFullScreen = () => {
        const container = playerContainerRef.current;
        if (!container) return;

        if (!isFullScreen) {
            if (container.requestFullscreen) container.requestFullscreen();
            else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
            else if (container.msRequestFullscreen) container.msRequestFullscreen();
        } else {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            else if (document.msExitFullscreen) document.msExitFullscreen();
        }
    };

    useEffect(() => {
        const handleFullScreenChange = () => setIsFullScreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handleFullScreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullScreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullScreenChange);
            document.removeEventListener('webkitfullscreenchange', handleFullScreenChange);
        };
    }, []);

    return (
        <div ref={playerContainerRef} className={`relative group w-full ${className || ''}`}>
            <div className="relative w-full">
                <video
                    className='w-full h-auto bg-black rounded'
                    ref={videoRef}
                    src={src}
                    onClick={togglePlayPause}
                    controls={false}
                    onPlay={(e) => {
                        startProgressLoop();
                        if (onPlay) onPlay(e);
                    }}
                    onPause={stopProgressLoop}
                    onLoadedMetadata={onLoadedMetadata}
                    onDurationChange={(e) => setTotalTime(e.currentTarget.duration)}
                    onSeeked={onSeeked}
                />
                
                <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-10">
                    {canvasRef && (
                        <canvas 
                            ref={canvasRef} 
                            onClick={handleCanvasClick}
                            className="w-full h-full pointer-events-auto cursor-crosshair" 
                        />
                    )}
                    {children} 
                </div>
            </div>
            
            <div className="flex flex-col gap-1 mt-1 p-2 bg-slate-100 rounded-b w-full">

                <input
                    type='range'
                    min='0'
                    max='100'
                    value={progress}
                    onChange={handleSeek}
                    className="flex-grow cursor-pointer"
                />

                <div className="flex flex-row items-center justify-between w-full h-8 flex-nowrap">
                    
                    {/* Left Side Group */}
                    <div className="flex flex-row items-center gap-2 sm:gap-4 h-full shrink-0">
                        <button onClick={togglePlayPause} className="h-8 w-8 p-0 m-0 shrink-0 flex items-center justify-center text-slate-700 hover:text-blue-600 transition-colors outline-none">
                            {isPlaying ? <FaPause size={16} /> : <FaPlay size={16} />}
                        </button>
                        
                        {/* Volume Group */}
                        <div className="flex flex-row items-center gap-1 h-full shrink-0">
                            <button onClick={toggleMute} className="h-8 w-8 p-0 m-0 shrink-0 flex items-center justify-center text-slate-700 hover:text-blue-600 transition-colors outline-none">
                                {isMuted ? <FaVolumeMute size={18} /> : <FaVolumeUp size={18} />}
                            </button>
                            <input
                                type='range'
                                min='0'
                                max='1'
                                step='0.05'
                                value={volume}
                                onChange={handleVolumeChange}
                                className="w-16 sm:w-20 cursor-pointer h-1.5 accent-blue-600 m-0 shrink-0"
                            />
                        </div>

                        <div className="text-xs font-medium text-slate-600 font-mono tracking-wide ml-2 select-none">
                            {formatTime(currentTime)} / {formatTime(totalTime)}
                        </div>
                    </div>

                    {/* Right Side Group */}
                    <div className="ml-auto flex items-center justify-center">
                        {/* Fullscreen Button */}
                        <button onClick={toggleFullScreen} className="h-8 w-12 flex items-center justify-center transition-colors outline-none hover:text-blue-600 transition-colors outline-none">
                            {isFullScreen ? <FaCompress size={18} /> : <FaExpand size={18} />}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};