import { AppError } from '../errors.js';
import type { RuntimeConfig } from '../config.js';
import type { VideoProvider, VideoProviderStatus, VideoTaskStatus } from './types.js';

const MODEL = 'doubao-seedance-2-5';
const STATUS: Record<string, VideoTaskStatus> = { QUEUED: 'queued', IN_PROGRESS: 'in_progress', SUCCESS: 'succeeded', FAILURE: 'failed' };

export class AiApiWayVideoProvider implements VideoProvider {
  private readonly baseUrl: string;
  constructor(private readonly config: Pick<RuntimeConfig, 'AI_API_KEY' | 'AI_API_BASE_URL'>) {
    this.baseUrl = config.AI_API_BASE_URL.replace(/\/$/u, '');
  }
  private headers() {
    if (!this.config.AI_API_KEY) throw new AppError('VIDEO_PROVIDER_NOT_CONFIGURED', 503, '视频生成服务尚未配置。');
    return { Authorization: `Bearer ${this.config.AI_API_KEY}`, 'Content-Type': 'application/json' };
  }
  async create(prompt: string) {
    const headers = this.headers();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/video/generations`, { method: 'POST', headers, body: JSON.stringify({ model: MODEL, prompt, metadata: { resolution: '720p', duration: 5, ratio: '16:9', generate_audio: false, watermark: false } }), signal: AbortSignal.timeout(30_000) });
    } catch { throw new AppError('VIDEO_PROVIDER_UNAVAILABLE', 503, '视频生成服务暂时不可用。'); }
    const body = await response.json().catch(() => null) as { task_id?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok || typeof body?.task_id !== 'string') throw new AppError('VIDEO_PROVIDER_REJECTED', 502, '视频生成任务创建失败。');
    return body.task_id;
  }
  async status(taskId: string): Promise<VideoProviderStatus> {
    const headers = this.headers();
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/video/generations/${encodeURIComponent(taskId)}`, { headers, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new AppError('VIDEO_PROVIDER_UNAVAILABLE', 503, '视频生成服务暂时不可用。'); }
    const body = await response.json().catch(() => null) as { data?: { status?: unknown; result_url?: unknown; fail_reason?: unknown } } | null;
    const data = body?.data;
    if (!response.ok || typeof data?.status !== 'string') throw new AppError('VIDEO_PROVIDER_REJECTED', 502, '视频任务状态查询失败。');
    const status = STATUS[data.status];
    if (!status) throw new AppError('VIDEO_PROVIDER_REJECTED', 502, '视频任务状态查询失败。');
    return { status, videoUrl: typeof data.result_url === 'string' ? data.result_url : null, errorMessage: typeof data.fail_reason === 'string' ? data.fail_reason.slice(0, 2_000) : null };
  }
}
