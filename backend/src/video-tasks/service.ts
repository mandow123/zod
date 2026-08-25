import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { VideoProvider, VideoTask, VideoTaskStore } from './types.js';

export class VideoTaskService {
  constructor(private readonly store: VideoTaskStore, private readonly provider: VideoProvider, private readonly now: () => Date = () => new Date()) {}
  async create(userId: string, prompt: string) {
    const taskId = await this.provider.create(prompt);
    return this.store.create({ id: randomUUID(), userId, taskId, prompt, now: this.now() });
  }
  async refresh(userId: string, taskId: string) {
    const existing = await this.store.getForUser(userId, taskId);
    if (!existing) throw new AppError('VIDEO_TASK_NOT_FOUND', 404, '视频任务不存在。');
    if (existing.status === 'succeeded' || existing.status === 'failed') return existing;
    const result = await this.provider.status(taskId);
    return (await this.store.updateStatus(userId, taskId, result.status, result.videoUrl, result.errorMessage)) ?? existing;
  }
  serialize(task: VideoTask) { return { id: task.id, taskId: task.taskId, prompt: task.prompt, status: task.status, videoUrl: task.videoUrl, errorMessage: task.errorMessage, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() }; }
}
