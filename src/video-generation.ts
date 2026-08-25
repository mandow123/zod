import { apiRequest } from './api-client';

export type VideoTaskStatus = 'queued' | 'in_progress' | 'succeeded' | 'failed';
export type VideoTask = Readonly<{ id: string; taskId: string; prompt: string; status: VideoTaskStatus; videoUrl: string | null; errorMessage: string | null; createdAt: string; updatedAt: string }>;
type TaskResponse = Readonly<{ ok: true; task: VideoTask }>;
export function createVideoTask(prompt: string) { return apiRequest<TaskResponse>('/mobile/v1/video-tasks', { method: 'POST', auth: 'required', retry: false, body: { prompt } }); }
export function getVideoTask(taskId: string) { return apiRequest<TaskResponse>(`/mobile/v1/video-tasks/${encodeURIComponent(taskId)}`, { auth: 'required', retry: false }); }
