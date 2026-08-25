import type { Database } from '../database.js';
import type { VideoTask, VideoTaskStatus, VideoTaskStore } from './types.js';

type Row = { id: string; user_id: string; task_id: string; prompt: string; status: VideoTaskStatus; video_url: string | null; error_message: string | null; created_at: Date; updated_at: Date };
const map = (row: Row): VideoTask => ({ id: row.id, userId: row.user_id, taskId: row.task_id, prompt: row.prompt, status: row.status, videoUrl: row.video_url, errorMessage: row.error_message, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) });

export class PostgresVideoTaskStore implements VideoTaskStore {
  constructor(private readonly database: Database) {}
  async create(input: Readonly<{ id: string; userId: string; taskId: string; prompt: string; now: Date }>) {
    const result = await this.database.query<Row>(`INSERT INTO video_tasks(id,user_id,task_id,prompt,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'queued',$5,$5) RETURNING id,user_id,task_id,prompt,status,video_url,error_message,created_at,updated_at`,
    [input.id, input.userId, input.taskId, input.prompt, input.now]);
    return map(result.rows[0]!);
  }
  async getForUser(userId: string, taskId: string) {
    const result = await this.database.query<Row>(`SELECT id,user_id,task_id,prompt,status,video_url,error_message,created_at,updated_at
      FROM video_tasks WHERE user_id=$1 AND task_id=$2`, [userId, taskId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async updateStatus(userId: string, taskId: string, status: VideoTaskStatus, videoUrl: string | null, errorMessage: string | null) {
    const result = await this.database.query<Row>(`UPDATE video_tasks SET status=$3,video_url=$4,error_message=$5,updated_at=now()
      WHERE user_id=$1 AND task_id=$2 RETURNING id,user_id,task_id,prompt,status,video_url,error_message,created_at,updated_at`,
    [userId, taskId, status, videoUrl, errorMessage]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
}
