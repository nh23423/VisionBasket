'use client';
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const WS_URL = API_URL.replace(/^http(s?):\/\//, 'ws$1://');

const api = axios.create({ baseURL: API_URL });

export type Detection = {
    id: number;
    bbox: number[];
};

export type Frame = {
    frame_id: number;
    detections: Detection[];
    mapped_points: [number, number][];
};

export interface PlayerState {
    track_id: number;
    bbox: number[];
}

export interface SwitchRangeCorrection {
    action: "SWITCH";
    start_frame: number;
    end_frame: number;
    start_state: [PlayerState, PlayerState];
    end_state: [PlayerState, PlayerState];
}

export interface AddTrackCorrection {
    action: "TRACK";
    trackId: number;
    bboxe: number[][];
    frames: number[];
}

export type SingleCorrection = {
    frame_idx: number;
    track_id: number;
    action: "DELETE";
};

export type BatchCorrectionRequest = {
    task_id: string;
    points: [number, number][];
    corrections: (SingleCorrection | SwitchRangeCorrection | AddTrackCorrection)[];
};

export type ProcessingStatus = {
    status: "started" | "processing" | "completed" | "failed" | "not_found";
    progress?: number;
    fps?: number;
    frames?: Frame[];
    error?: string;
};

export interface StartUploadResponse {
    urls: string[];
    chunk_size: number;
    key: string;
    upload_id: string;
    fields: Record<string, any>;
};

export interface CompleteUploadResponse {
    url: string;
    task_id: string;
    frame: string;
    setup_pts: [number, number][];
};

const retryRequest = async (fn: () => Promise<any>, retries = 3): Promise<any> => {
    try {
        return await fn();
    } catch (err) {
        if (retries <= 0) throw err;
        console.warn(`Chunk failed, retrying... (${retries} attempts left)`);
        return await retryRequest(fn, retries - 1);
    }
};

export class APIService {

    static async upload(
        file: File,
        onProgress: (percent: number) => void
    ): Promise<{ task_id: string, frame: string, setup_pts: [number, number][] }> {

        const startRes = await api.post<StartUploadResponse>('/start-upload', {
            filename: file.name,
            content_type: file.type,
            file_size: file.size
        });
        const { urls, key, upload_id } = startRes.data;

        const CHUNK_SIZE = 10 * 1024 * 1024;
        const etags: string[] = [];
        let uploadedBytes = 0;

        const maxConcurrent = 3;
        for (let i = 0; i < urls.length; i += maxConcurrent) {

            const batchUrls = urls.slice(i, i + maxConcurrent);
            const promises = batchUrls.map(async (uploadUrl, batchIdx) => {
                const chunkIndex = i + batchIdx;
                const start = chunkIndex * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                // video is split into designated chunk
                const chunk = file.slice(start, end);

                const res = await retryRequest(() => axios.put(uploadUrl, chunk, {
                    headers: { 'Content-Type': file.type }
                }));

                const eTag = res.headers.etag?.replace(/"/g, '') || res.headers['etag']?.replace(/"/g, '');
                if (!eTag) throw new Error("ETag missing. Check MinIO CORS settings.");

                etags[chunkIndex] = eTag;

                uploadedBytes += chunk.size;
                onProgress(Math.round((uploadedBytes / file.size) * 100));
            });

            await Promise.all(promises);

        }

        const etagsString = etags.join(',');
        const completeRes = await api.post<CompleteUploadResponse>('/complete-upload', {
            key,
            upload_id,
            etags: etagsString
        });

        return completeRes.data;
    }

    static async analyse(task_id: string, points: [number, number][]): Promise<{ task_id: string }> {
        const response = await api.post('/analyse', { task_id, points }, {
            headers: {
                'Content-Type': 'application/json',
            }
        });
        return response.data;
    }

    static async correction(payload: BatchCorrectionRequest) {
        const response = await api.post('/correction', payload, {
            headers: {
                'Content-Type': 'application/json',
            }
        });
        return response.data;
    }

    static connectToTask(taskId: string, onMessage: (data: ProcessingStatus) => void, onError?: (error: Event) => void): WebSocket {
        const ws = new WebSocket(`${WS_URL}/ws/${taskId}`);

        ws.onmessage = (event) => {
            const data: ProcessingStatus = JSON.parse(event.data);
            onMessage(data);
        };

        ws.onerror = (error) => {
            onError?.(error);
        };

        return ws;
    }
}