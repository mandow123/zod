import { describe, expect, it, vi } from 'vitest';
import { AiApiWayVideoProvider } from '../src/video-tasks/provider.js';
import { VideoTaskService } from '../src/video-tasks/service.js';
import type { VideoTask, VideoTaskStore } from '../src/video-tasks/types.js';

const apiKey = 'seedance-secret-key';
const baseUrl = 'https://gw.aiapiway.com/v1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AI API WAY Seedance provider', () => {
  it('creates a task with the official endpoint, model, metadata, and private authorization', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return json({ task_id: 'seed-task-001' });
    });
    const provider = new AiApiWayVideoProvider({ AI_API_KEY: apiKey, AI_API_BASE_URL: baseUrl });

    await expect(provider.create('KAI enters a luminous 3D city')).resolves.toBe('seed-task-001');
    expect(capturedUrl).toBe(`${baseUrl}/video/generations`);
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toMatchObject({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'doubao-seedance-2-5', prompt: 'KAI enters a luminous 3D city' });
    expect(body.metadata).toEqual({
      resolution: '720p',
      duration: 5,
      ratio: '16:9',
      generate_audio: false,
      watermark: false,
    });
    expect(String(capturedInit?.body)).not.toContain(apiKey);
    fetchSpy.mockRestore();
  });

  it('queries status and maps success and failure payloads without exposing credentials', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? json({ data: { status: 'SUCCESS', result_url: 'https://cdn.example/video.mp4' } })
        : json({ data: { status: 'FAILURE', fail_reason: 'content policy rejected' } });
    });
    const provider = new AiApiWayVideoProvider({ AI_API_KEY: apiKey, AI_API_BASE_URL: baseUrl });

    await expect(provider.status('seed/task 001')).resolves.toEqual({
      status: 'succeeded',
      videoUrl: 'https://cdn.example/video.mp4',
      errorMessage: null,
    });
    await expect(provider.status('seed/task 002')).resolves.toEqual({
      status: 'failed',
      videoUrl: null,
      errorMessage: 'content policy rejected',
    });
    expect(requests[0]?.url).toBe(`${baseUrl}/video/generations/seed%2Ftask%20001`);
    expect(requests[0]?.init?.headers).toEqual({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
    expect(requests.every((request) => !String(request.init?.body ?? '').includes(apiKey))).toBe(true);
    fetchSpy.mockRestore();
  });

  it('fails closed when the server-side key is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new AiApiWayVideoProvider({ AI_API_KEY: undefined, AI_API_BASE_URL: baseUrl });
    await expect(provider.create('test prompt')).rejects.toMatchObject({ code: 'VIDEO_PROVIDER_NOT_CONFIGURED' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function task(userId: string, taskId = 'seed-task-001', status: VideoTask['status'] = 'queued'): VideoTask {
  const now = new Date('2026-08-19T00:00:00.000Z');
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, taskId,
    prompt: 'KAI enters a luminous 3D city', status, videoUrl: null, errorMessage: null,
    createdAt: now, updatedAt: now,
  };
}

describe('VideoTaskService', () => {
  it('persists the provider task id and refreshes successful and failed states', async () => {
    const saved: VideoTask[] = [];
    const store: VideoTaskStore = {
      create: vi.fn(async (input) => {
        const value = task(input.userId, input.taskId);
        saved.push(value);
        return value;
      }),
      getForUser: vi.fn(async (userId, taskId) => saved.find((item) => item.userId === userId && item.taskId === taskId) ?? null),
      updateStatus: vi.fn(async (userId, taskId, status, videoUrl, errorMessage) => {
        const current = saved.find((item) => item.userId === userId && item.taskId === taskId);
        if (!current) return null;
        const updated = { ...current, status, videoUrl, errorMessage, updatedAt: new Date('2026-08-19T00:00:05.000Z') };
        saved.splice(saved.indexOf(current), 1, updated);
        return updated;
      }),
    };
    const provider = {
      create: vi.fn()
        .mockResolvedValueOnce('seed-task-001')
        .mockResolvedValueOnce('seed-task-002'),
      status: vi.fn()
        .mockResolvedValueOnce({ status: 'succeeded', videoUrl: 'https://cdn.example/success.mp4', errorMessage: null })
        .mockResolvedValueOnce({ status: 'failed', videoUrl: null, errorMessage: 'provider rejected prompt' }),
    };
    const service = new VideoTaskService(store, provider, () => new Date('2026-08-19T00:00:00.000Z'));
    const created = await service.create('user-a', 'KAI enters a luminous 3D city');
    expect(created.taskId).toBe('seed-task-001');
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', taskId: 'seed-task-001' }));
    await expect(service.refresh('user-a', 'seed-task-001')).resolves.toMatchObject({ status: 'succeeded', videoUrl: 'https://cdn.example/success.mp4' });
    const failed = await service.create('user-a', 'KAI falls into a dark portal');
    await expect(service.refresh('user-a', failed.taskId)).resolves.toMatchObject({ status: 'failed', errorMessage: 'provider rejected prompt' });
  });

  it('enforces user isolation before contacting the provider', async () => {
    const store: VideoTaskStore = {
      create: vi.fn(),
      getForUser: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
    };
    const provider = { create: vi.fn(), status: vi.fn() };
    const service = new VideoTaskService(store, provider);
    await expect(service.refresh('another-user', 'seed-task-001')).rejects.toMatchObject({ code: 'VIDEO_TASK_NOT_FOUND', statusCode: 404 });
    expect(provider.status).not.toHaveBeenCalled();
    expect(store.getForUser).toHaveBeenCalledWith('another-user', 'seed-task-001');
  });
});
