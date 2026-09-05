export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRunRecord {
  id: string;
  jobType: string;
  status: JobStatus;
  checkpoint: unknown;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  errorDetail: string | null;
  createdAt: string;
}
