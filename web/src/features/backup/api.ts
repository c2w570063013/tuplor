import type {
  BackupFile, BackupOptions, BackupTreeSchema, JobInfo, JobLogResponse, RestoreFormat, RestoreOptions, ToolsInfo,
} from '@shared/backup';
import { ApiError, dbUrl, http } from '@/lib/api';

const enc = encodeURIComponent;

export const backupApi = {
  tools: (connId: string, refresh = false) => http.get<ToolsInfo>(`/api/backup/tools?connId=${enc(connId)}${refresh ? '&refresh=1' : ''}`),
  setBinDir: (binDir: string | null) => http.put<{ ok: boolean }>('/api/backup/settings', { binDir }),
  tree: (connId: string, db: string) => http.get<BackupTreeSchema[]>(`${dbUrl(connId, db)}/backup/tree`),
  startBackup: (connId: string, db: string, o: BackupOptions) => http.post<JobInfo>(`${dbUrl(connId, db)}/backup`, o),
  startRestore: (connId: string, o: RestoreOptions) => http.post<JobInfo>(`/api/c/${enc(connId)}/restore`, o),
  jobs: () => http.get<JobInfo[]>('/api/backup/jobs'),
  job: (id: string, since: number) => http.get<JobLogResponse>(`/api/backup/jobs/${enc(id)}?since=${since}`),
  cancel: (id: string) => http.post<{ ok: boolean }>(`/api/backup/jobs/${enc(id)}/cancel`),
  files: () => http.get<BackupFile[]>('/api/backup/files'),
  deleteFile: (name: string) => http.del<{ ok: boolean }>(`/api/backup/files/${enc(name)}`),
  downloadUrl: (name: string) => `/api/backup/files/${enc(name)}/download`,
  async upload(file: File, onProgress?: (fraction: number) => void): Promise<BackupFile> {
    // XHR for upload progress (fetch has no upload progress events)
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/backup/upload?name=${enc(file.name)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data: any;
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data?.error ?? { message: xhr.statusText || 'Upload failed' }));
      };
      xhr.onerror = () => reject(new ApiError(0, { message: 'Upload failed (network error)' }));
      xhr.send(file);
    });
  },
};

export const FORMAT_LABEL: Record<RestoreFormat | 'unknown', string> = {
  custom: 'Custom',
  plain: 'SQL',
  'plain-gz': 'SQL.gz',
  directory: 'Directory',
  tar: 'Tar',
  unknown: 'Unknown',
};

export const isPlain = (f: RestoreFormat | 'unknown' | undefined) => f === 'plain' || f === 'plain-gz';
