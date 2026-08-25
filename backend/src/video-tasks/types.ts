export type VideoTaskStatus = 'queued' | 'in_progress' | 'succeeded' | 'failed';

export type VideoTask = Readonly<{
  id: string;
  userId: string;
  taskId: string;
  prompt: string;
  status: VideoTaskStatus;
  videoUrl: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type VideoProviderStatus = Readonly<{
  status: VideoTaskStatus;
  videoUrl: string | null;
  errorMessage: string | null;
}>;

export interface VideoTaskStore {
  create(input: Readonly<{ id: string; userId: string; taskId: string; prompt: string; now: Date }>): Promise<VideoTask>;
  getForUser(userId: string, taskId: string): Promise<VideoTask | null>;
  updateStatus(userId: string, taskId: string, status: VideoTaskStatus, videoUrl: string | null, errorMessage: string | null): Promise<VideoTask | null>;
}

export interface VideoProvider {
  create(prompt: string): Promise<string>;
  status(taskId: string): Promise<VideoProviderStatus>;
}
