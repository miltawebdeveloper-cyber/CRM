import { api } from './api';

/**
 * Background jobs — long operations (lead import, Quo sync-all) that the API
 * runs behind the request that started them. The start request returns a job;
 * the client polls it until it finishes.
 */
export interface BackgroundJob<R = unknown> {
  id: string;
  kind: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  result: R | null;
  error: string | null;
}

const JOB_POLL_MS = 1_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a background job until it finishes. Transient poll failures (a network
 * blip, a redeploy in progress) are retried rather than abandoning a job that is
 * still running on the server; after a run of them the wait gives up.
 */
export async function waitForJob<R>(
  url: string,
  onProgress?: (processed: number, total: number) => void,
): Promise<BackgroundJob<R>> {
  let failures = 0;
  for (;;) {
    try {
      const job = (await api.get(url)).data as BackgroundJob<R>;
      failures = 0;
      onProgress?.(job.processed, job.total);
      if (job.status !== 'running') return job;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 403) throw err; // not ours / gone — retrying won't help
      if (++failures >= 20) throw err;
    }
    await sleep(JOB_POLL_MS);
  }
}
