CREATE TABLE video_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id text NOT NULL UNIQUE,
  prompt text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','in_progress','succeeded','failed')),
  video_url text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_tasks_user_created_idx ON video_tasks(user_id, created_at DESC);
