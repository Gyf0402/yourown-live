import crypto from 'node:crypto';
import { app, session, shell } from 'electron';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppUpdateCheckResult,
  UpdateAssetInfo,
  UpdateDownloadChannel,
  UpdateDownloadOptions,
  UpdateDownloadProgress,
} from '../shared/types';
import { recordDiagnostic } from './diagnostics';

const GITHUB_OWNER = 'Gyf0402';
const GITHUB_REPO = 'yourown-live';
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const LATEST_RELEASE_HTML_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

// Curated China-friendly GitHub release proxy nodes (always paired with official SHA-256 verification)
const GITHUB_MIRRORS: Array<{ id: string; label: string; prefix: string }> = [
  { id: 'edgeone', label: 'EdgeOne 加速', prefix: 'https://edgeone.gh-proxy.org/' },
  { id: 'hk', label: '香港加速', prefix: 'https://hk.gh-proxy.org/' },
  { id: 'ghfast', label: 'GHFast 加速', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy', label: 'GHProxy 加速', prefix: 'https://gh-proxy.org/' },
];

const PARALLEL_SEGMENTS = 6;
const MIN_PARALLEL_BYTES = 4 * 1024 * 1024; // 4 MB
const SEGMENT_FLUSH_BYTES = 1024 * 1024; // 1 MB positioned write batch per worker
const SINGLE_STREAM_HIGH_WATER_MARK = 4 * 1024 * 1024; // 4 MB write buffer

let activeDownloadController: AbortController | null = null;
const activeDownloadReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
let activeDownloadPartPath: string | null = null;

function normalizeVersion(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^v/i, '')
    .split('+')[0];
}

function parseSha256Hex(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = String(raw)
    .trim()
    .replace(/^sha256:/i, '')
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : undefined;
}

export function compareSemver(a: string, b: string): number {
  const normA = normalizeVersion(a);
  const normB = normalizeVersion(b);
  const [coreA, preA = ''] = normA.split('-');
  const [coreB, preB = ''] = normB.split('-');
  const partsA = coreA.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const partsB = coreB.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length, 3);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  if (preA === preB) return 0;
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB);
}

export function isPortableInstall(): boolean {
  if (!app.isPackaged) return false;
  try {
    const exeDir = path.dirname(process.execPath);
    const hasUninstaller =
      existsSync(path.join(exeDir, 'Uninstall YourOwn Live.exe')) ||
      existsSync(path.join(exeDir, 'Uninstall.exe'));
    if (hasUninstaller) return false;
    const lowerPath = exeDir.toLowerCase();
    if (
      lowerPath.includes('\\program files\\') ||
      lowerPath.includes('\\program files (x86)\\') ||
      lowerPath.includes('\\appdata\\local\\programs\\')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function getUpdateTempDir(): string {
  return path.join(app.getPath('temp'), 'yourown-live-updates');
}

function sanitizeFileName(raw: string): string {
  const base = path.basename(String(raw || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || `YourOwn-Live-Update-${Date.now()}.exe`;
}

function isAllowedUpdateUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'github.com') {
      return u.pathname
        .toLowerCase()
        .startsWith(`/${GITHUB_OWNER.toLowerCase()}/${GITHUB_REPO.toLowerCase()}/`);
    }
    return ALLOWED_DOWNLOAD_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

interface GithubAssetPayload {
  name?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAssetPayload[];
}

function pickAssets(assets: GithubAssetPayload[] = []): {
  installerAsset?: UpdateAssetInfo;
  portableAsset?: UpdateAssetInfo;
  checksumsUrl?: string;
} {
  let installerAsset: UpdateAssetInfo | undefined;
  let portableAsset: UpdateAssetInfo | undefined;
  let checksumsUrl: string | undefined;
  for (const a of assets) {
    const name = typeof a?.name === 'string' ? a.name : '';
    const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
    const size = typeof a?.size === 'number' && Number.isFinite(a.size) ? a.size : 0;
    const sha256 = parseSha256Hex(a?.digest);
    if (!name || !url) continue;
    const lower = name.toLowerCase();
    if (!checksumsUrl && lower === 'sha256sums.txt') {
      checksumsUrl = url;
    } else if (!installerAsset && lower.endsWith('.exe')) {
      installerAsset = { name, url, size, ...(sha256 ? { sha256 } : {}) };
    } else if (!portableAsset && lower.endsWith('.zip')) {
      portableAsset = { name, url, size, ...(sha256 ? { sha256 } : {}) };
    }
  }
  return { installerAsset, portableAsset, checksumsUrl };
}

function getUpdaterSession() {
  return session.fromPartition('updater');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await getUpdaterSession().fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      const timeoutErr = new Error('REQUEST_TIMEOUT');
      timeoutErr.name = 'AbortError';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function fetchOfficialSha256FromChecksums(
  checksumsUrl: string,
  fileName: string,
  parentSignal?: AbortSignal
): Promise<string | undefined> {
  if (!isAllowedUpdateUrl(checksumsUrl)) return undefined;
  try {
    const res = await fetchWithTimeout(
      checksumsUrl,
      {
        redirect: 'follow',
        headers: { 'User-Agent': `YourOwn-Live/${app.getVersion()}` },
      },
      8000,
      parentSignal
    );
    if (!res.ok) return undefined;
    const text = await res.text();
    const targetLower = path.basename(fileName).toLowerCase();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
      if (!m) continue;
      const entryName = path.basename(m[2].trim()).toLowerCase();
      if (entryName === targetLower) {
        return m[1].toLowerCase();
      }
    }
  } catch {
    // Ignore checksums fetch errors; caller decides fallback policy
  }
  return undefined;
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });
}

export async function checkForAppUpdates(overrideCurrentVersion?: string): Promise<AppUpdateCheckResult> {
  const currentVersion = normalizeVersion(overrideCurrentVersion || app.getVersion());
  const portable = isPortableInstall();
  const ua = `YourOwn-Live/${currentVersion}`;

  try {
    const res = await fetchWithTimeout(
      LATEST_RELEASE_API_URL,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': ua,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      10000
    );

    if (res.ok) {
      const data = (await res.json()) as GithubReleasePayload;
      const latestVersion = normalizeVersion(data.tag_name || data.name || '');
      if (latestVersion) {
        const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
        const { installerAsset, portableAsset, checksumsUrl } = pickAssets(data.assets);
        const releaseUrl = data.html_url || `${RELEASES_PAGE_URL}/tag/v${latestVersion}`;
        recordDiagnostic(
          'info',
          'system',
          hasUpdate
            ? `检查更新：发现新版本 v${latestVersion}（当前 v${currentVersion}）`
            : `检查更新：当前已是最新版本 v${currentVersion}`
        );
        return {
          ok: true,
          currentVersion,
          latestVersion,
          hasUpdate,
          releaseName: data.name || `YourOwn Live v${latestVersion}`,
          releaseNotes: (data.body || '').trim(),
          publishedAt: data.published_at,
          releaseUrl,
          installerAsset,
          portableAsset,
          checksumsUrl,
          isPortableInstall: portable,
        };
      }
    }

    // Fallback: follow GitHub /releases/latest redirect (works even if GitHub API rate-limits anonymous IP)
    const fallbackRes = await fetchWithTimeout(
      LATEST_RELEASE_HTML_URL,
      {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': ua },
      },
      10000
    );
    const finalUrl = fallbackRes.url || '';
    const tagMatch = finalUrl.match(/\/releases\/tag\/([^/?#]+)/i);
    if (tagMatch?.[1]) {
      const tag = decodeURIComponent(tagMatch[1]);
      const latestVersion = normalizeVersion(tag);
      const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
      const installerName = `YourOwn-Live-${latestVersion}-win-x64-Setup.exe`;
      const portableName = `YourOwn-Live-${latestVersion}-win-x64-Portable.zip`;
      const baseDl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${encodeURIComponent(tag)}`;
      recordDiagnostic(
        'info',
        'system',
        hasUpdate
          ? `检查更新（备用通道）：发现新版本 v${latestVersion}（当前 v${currentVersion}）`
          : `检查更新（备用通道）：当前已是最新版本 v${currentVersion}`
      );
      return {
        ok: true,
        currentVersion,
        latestVersion,
        hasUpdate,
        releaseName: `YourOwn Live ${tag}`,
        releaseNotes: '点击下方按钮直接下载更新，或前往 GitHub Release 页面查看完整更新说明。',
        releaseUrl: finalUrl,
        installerAsset: { name: installerName, url: `${baseDl}/${installerName}`, size: 0 },
        portableAsset: { name: portableName, url: `${baseDl}/${portableName}`, size: 0 },
        checksumsUrl: `${baseDl}/SHA256SUMS.txt`,
        isPortableInstall: portable,
      };
    }

    throw new Error(`GitHub 返回状态码 ${res.status}`);
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '连接 GitHub 超时，请稍后重试或直接前往 Release 页面'
          : err.message
        : '检查更新失败';
    recordDiagnostic('warn', 'system', `检查更新失败：${msg}`);
    return {
      ok: false,
      currentVersion,
      hasUpdate: false,
      releaseUrl: RELEASES_PAGE_URL,
      isPortableInstall: portable,
      error: msg,
    };
  }
}

export async function cancelActiveUpdateDownload(): Promise<void> {
  if (activeDownloadController) {
    try {
      activeDownloadController.abort();
    } catch {
      // Ignore abort errors
    }
    activeDownloadController = null;
  }
  if (activeDownloadReaders.size > 0) {
    const readers = Array.from(activeDownloadReaders);
    activeDownloadReaders.clear();
    await Promise.all(readers.map((r) => r.cancel().catch(() => {})));
  }
  if (activeDownloadPartPath) {
    const partPath = activeDownloadPartPath;
    activeDownloadPartPath = null;
    await fs.unlink(partPath).catch(() => {});
  }
}

interface ResolvedEndpoint {
  resolvedUrl: string;
  totalBytes: number;
  supportsRange: boolean;
  channel: UpdateDownloadChannel;
  nodeLabel: string;
}

function parseContentRangeTotal(header: string | null): number {
  if (!header) return 0;
  const m = header.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (!m) return 0;
  const total = Number(m[1]);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

async function probeDownloadEndpoint(
  probeUrl: string,
  channel: UpdateDownloadChannel,
  nodeLabel: string,
  timeoutMs: number,
  parentSignal: AbortSignal
): Promise<ResolvedEndpoint> {
  const resp = await fetchWithTimeout(
    probeUrl,
    {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': `YourOwn-Live/${app.getVersion()}`,
      },
    },
    timeoutMs,
    parentSignal
  );

  try {
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (!resp.ok || contentType.includes('text/html')) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const resolvedUrl = resp.url || probeUrl;
    if (resp.status === 206) {
      const totalBytes = parseContentRangeTotal(resp.headers.get('content-range'));
      if (totalBytes <= 0) {
        throw new Error('无效的 Content-Range');
      }
      return {
        resolvedUrl,
        totalBytes,
        supportsRange: true,
        channel,
        nodeLabel,
      };
    }

    const totalBytes = Number(resp.headers.get('content-length') || 0) || 0;
    return {
      resolvedUrl,
      totalBytes,
      supportsRange: false,
      channel,
      nodeLabel,
    };
  } finally {
    await resp.body?.cancel().catch(() => {});
  }
}

async function resolveDownloadEndpoint(
  officialUrl: string,
  preferredChannel: UpdateDownloadChannel,
  parentSignal: AbortSignal
): Promise<ResolvedEndpoint> {
  if (preferredChannel === 'mirror') {
    const probeController = new AbortController();
    const onParentAbort = () => probeController.abort();
    if (parentSignal.aborted) {
      probeController.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    try {
      const mirrorPromises = GITHUB_MIRRORS.map((m) =>
        probeDownloadEndpoint(
          `${m.prefix}${officialUrl}`,
          'mirror',
          m.label,
          6500,
          probeController.signal
        ).then((res) => {
          if (res.totalBytes > 0 && res.totalBytes < 512 * 1024) {
            throw new Error('镜像返回文件异常过小');
          }
          return res;
        })
      );

      // Race all mirror nodes and pick the fastest healthy responder immediately
      const fastest = await Promise.any(mirrorPromises);
      probeController.abort(); // Cancel slower mirror probes
      return fastest;
    } catch {
      if (parentSignal.aborted) {
        throw new Error('DOWNLOAD_ABORTED');
      }
      recordDiagnostic('warn', 'system', '加速镜像暂不可用，自动回退官方直连下载');
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  return probeDownloadEndpoint(officialUrl, 'direct', '官方直连', 18000, parentSignal);
}

interface ProgressTracker {
  addBytes: (delta: number) => void;
  setTotalBytes: (total: number) => void;
  getDownloaded: () => number;
  emitNow: () => void;
}

function createProgressTracker(
  initialTotal: number,
  fileName: string,
  channel: UpdateDownloadChannel,
  sourceLabel: string,
  signal: AbortSignal,
  emitProgress: (progress: UpdateDownloadProgress) => void
): ProgressTracker {
  let downloadedBytes = 0;
  let totalBytes = initialTotal;
  const speedWindow: Array<{ ts: number; bytes: number }> = [{ ts: Date.now(), bytes: 0 }];
  let lastEmitTs = 0;

  const computeSpeed = (now: number): number => {
    speedWindow.push({ ts: now, bytes: downloadedBytes });
    while (speedWindow.length > 2 && now - speedWindow[0].ts > 1600) {
      speedWindow.shift();
    }
    const oldest = speedWindow[0];
    const elapsedSec = Math.max(0.15, (now - oldest.ts) / 1000);
    return Math.max(0, Math.round((downloadedBytes - oldest.bytes) / elapsedSec));
  };

  const emitNow = () => {
    if (signal.aborted) return;
    const now = Date.now();
    const speedBytesPerSec = computeSpeed(now);
    const percent =
      totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
    emitProgress({
      phase: 'downloading',
      percent,
      downloadedBytes,
      totalBytes,
      speedBytesPerSec,
      fileName,
      channel,
      sourceLabel,
    });
    lastEmitTs = now;
  };

  return {
    addBytes(delta: number) {
      if (delta <= 0) return;
      downloadedBytes += delta;
      const now = Date.now();
      if (now - lastEmitTs >= 180) {
        emitNow();
      }
    },
    setTotalBytes(total: number) {
      if (total > 0) totalBytes = total;
    },
    getDownloaded() {
      return downloadedBytes;
    },
    emitNow,
  };
}

async function downloadInParallelRanges(
  targetUrl: string,
  partPath: string,
  totalBytes: number,
  channel: UpdateDownloadChannel,
  nodeLabel: string,
  fileName: string,
  controller: AbortController,
  abortPromise: Promise<never>,
  emitProgress: (progress: UpdateDownloadProgress) => void
): Promise<number> {
  const segmentCount = Math.min(
    PARALLEL_SEGMENTS,
    Math.max(2, Math.ceil(totalBytes / MIN_PARALLEL_BYTES))
  );
  const sourceLabel = `${nodeLabel} (${segmentCount} 线程)`;
  const tracker = createProgressTracker(
    totalBytes,
    fileName,
    channel,
    sourceLabel,
    controller.signal,
    emitProgress
  );
  tracker.emitNow();

  const fh = await fs.open(partPath, 'w');
  try {
    await fh.truncate(totalBytes);

    const segmentSize = Math.ceil(totalBytes / segmentCount);
    const segments: Array<{ index: number; start: number; end: number }> = [];
    for (let i = 0; i < segmentCount; i++) {
      const start = i * segmentSize;
      if (start >= totalBytes) break;
      const end = Math.min(totalBytes - 1, start + segmentSize - 1);
      segments.push({ index: i, start, end });
    }

    const downloadSegment = async (seg: { index: number; start: number; end: number }) => {
      const expectedLen = seg.end - seg.start + 1;
      let segWritten = 0;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.signal.aborted) throw new Error('DOWNLOAD_ABORTED');
        const rangeStart = seg.start + segWritten;
        if (rangeStart > seg.end) return;

        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
          const resp = await fetchWithTimeout(
            targetUrl,
            {
              method: 'GET',
              redirect: 'follow',
              headers: {
                Range: `bytes=${rangeStart}-${seg.end}`,
                'User-Agent': `YourOwn-Live/${app.getVersion()}`,
              },
            },
            20000,
            controller.signal
          );

          if (resp.status !== 206 || !resp.body) {
            await resp.body?.cancel().catch(() => {});
            throw new Error(`分片 #${seg.index + 1} 未返回 206 (HTTP ${resp.status})`);
          }

          reader = resp.body.getReader();
          activeDownloadReaders.add(reader);

          const pendingChunks: Uint8Array[] = [];
          let pendingLen = 0;
          let flushOffset = rangeStart;

          const flushBuffer = async () => {
            if (pendingLen <= 0) return;
            const merged =
              pendingChunks.length === 1
                ? pendingChunks[0]
                : Buffer.concat(pendingChunks, pendingLen);
            pendingChunks.length = 0;
            pendingLen = 0;
            await fh.write(merged, 0, merged.byteLength, flushOffset);
            flushOffset += merged.byteLength;
          };

          while (true) {
            if (controller.signal.aborted) throw new Error('DOWNLOAD_ABORTED');
            const { done, value } = await Promise.race([reader.read(), abortPromise]);
            if (controller.signal.aborted) throw new Error('DOWNLOAD_ABORTED');
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            const remaining = expectedLen - segWritten;
            const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
            if (slice.byteLength === 0) break;

            pendingChunks.push(slice);
            pendingLen += slice.byteLength;
            segWritten += slice.byteLength;
            tracker.addBytes(slice.byteLength);

            if (pendingLen >= SEGMENT_FLUSH_BYTES) {
              await flushBuffer();
            }
            if (segWritten >= expectedLen) break;
          }

          await flushBuffer();

          if (segWritten >= expectedLen) {
            return;
          }
          throw new Error(`分片 #${seg.index + 1} 提前结束 (${segWritten}/${expectedLen})`);
        } catch (err) {
          if (controller.signal.aborted || attempt === 2) {
            throw err;
          }
          await new Promise<void>((r) => setTimeout(r, 400 * (attempt + 1)));
        } finally {
          if (reader) {
            activeDownloadReaders.delete(reader);
            await reader.cancel().catch(() => {});
          }
        }
      }
    };

    await Promise.all(segments.map((seg) => downloadSegment(seg)));
    const finalBytes = tracker.getDownloaded();
    if (finalBytes !== totalBytes) {
      throw new Error(`文件体积不完整 (${finalBytes}/${totalBytes})`);
    }
    return finalBytes;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function downloadSingleStream(
  targetUrl: string,
  partPath: string,
  expectedTotalBytes: number,
  channel: UpdateDownloadChannel,
  nodeLabel: string,
  fileName: string,
  controller: AbortController,
  abortPromise: Promise<never>,
  emitProgress: (progress: UpdateDownloadProgress) => void
): Promise<number> {
  const response = await fetchWithTimeout(
    targetUrl,
    {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': `YourOwn-Live/${app.getVersion()}`,
      },
    },
    20000,
    controller.signal
  );

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!response.ok || !response.body || contentType.includes('text/html')) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }

  const totalBytes = Number(response.headers.get('content-length') || 0) || expectedTotalBytes;
  const sourceLabel = `${nodeLabel} (单流高速缓冲)`;
  const tracker = createProgressTracker(
    totalBytes,
    fileName,
    channel,
    sourceLabel,
    controller.signal,
    emitProgress
  );
  tracker.setTotalBytes(totalBytes);
  tracker.emitNow();

  const fileStream = createWriteStream(partPath, {
    highWaterMark: SINGLE_STREAM_HIGH_WATER_MARK,
  });
  let fileStreamError: Error | null = null;
  fileStream.on('error', (err) => {
    fileStreamError = err instanceof Error ? err : new Error(String(err));
  });

  const reader = response.body.getReader();
  activeDownloadReaders.add(reader);

  try {
    while (true) {
      if (controller.signal.aborted) throw new Error('DOWNLOAD_ABORTED');
      if (fileStreamError) throw fileStreamError;
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (controller.signal.aborted) throw new Error('DOWNLOAD_ABORTED');
      if (fileStreamError) throw fileStreamError;
      if (done) break;
      if (value && value.byteLength > 0) {
        if (!fileStream.write(value)) {
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                fileStream.off('drain', onDrain);
                fileStream.off('error', onErr);
                fileStream.off('close', onClose);
              };
              const onDrain = () => {
                cleanup();
                resolve();
              };
              const onErr = (err: Error) => {
                cleanup();
                reject(err);
              };
              const onClose = () => {
                cleanup();
                reject(fileStreamError || new Error('更新文件写入中断'));
              };
              fileStream.once('drain', onDrain);
              fileStream.once('error', onErr);
              fileStream.once('close', onClose);
            }),
            abortPromise,
          ]);
        }
        if (fileStreamError) throw fileStreamError;
        tracker.addBytes(value.byteLength);
      }
    }
    if (fileStreamError) throw fileStreamError;
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      fileStream.once('error', onErr);
      fileStream.end(() => {
        fileStream.off('error', onErr);
        if (fileStreamError) reject(fileStreamError);
        else resolve();
      });
    });
    return tracker.getDownloaded();
  } catch (streamErr) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 120);
      fileStream.once('close', done);
      fileStream.destroy();
    });
    throw streamErr;
  } finally {
    activeDownloadReaders.delete(reader);
    await reader.cancel().catch(() => {});
  }
}

export async function downloadUpdateAsset(
  url: string,
  fileName: string,
  emitProgress: (progress: UpdateDownloadProgress) => void,
  options?: UpdateDownloadOptions
): Promise<{
  ok: boolean;
  filePath?: string;
  cancelled?: boolean;
  verifiedSha256?: boolean;
  error?: string;
}> {
  if (!isAllowedUpdateUrl(url)) {
    return { ok: false, error: '非法更新下载地址，仅允许从官方 GitHub Releases 下载' };
  }

  await cancelActiveUpdateDownload();

  const safeName = sanitizeFileName(fileName);
  const targetDir = getUpdateTempDir();
  await fs.mkdir(targetDir, { recursive: true });
  const finalPath = path.join(targetDir, safeName);
  const partPath = `${finalPath}.part`;

  const controller = new AbortController();
  activeDownloadController = controller;
  activeDownloadPartPath = partPath;

  let channel: UpdateDownloadChannel = options?.channel === 'mirror' ? 'mirror' : 'direct';

  emitProgress({
    phase: 'downloading',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speedBytesPerSec: 0,
    fileName: safeName,
    channel,
    sourceLabel: channel === 'mirror' ? '正在优选加速节点...' : '正在连接官方节点...',
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(new Error('DOWNLOAD_ABORTED'));
      return;
    }
    controller.signal.addEventListener('abort', () => reject(new Error('DOWNLOAD_ABORTED')), {
      once: true,
    });
  });
  // Prevent UnhandledPromiseRejection if abort fires after Promise.race settles
  abortPromise.catch(() => {});

  try {
    // Resolve official SHA-256 checksum (ONLY from official GitHub API digest or official SHA256SUMS.txt)
    let expectedSha256 = parseSha256Hex(options?.expectedSha256);
    if (!expectedSha256 && options?.checksumsUrl) {
      expectedSha256 = await fetchOfficialSha256FromChecksums(
        options.checksumsUrl,
        safeName,
        controller.signal
      );
    }

    // Security guard: never trust an unverified binary from a third-party mirror
    if (channel === 'mirror' && !expectedSha256) {
      recordDiagnostic(
        'warn',
        'system',
        '未获取到官方 SHA-256 校验值，为保证安全已自动切换为官方直连下载'
      );
      channel = 'direct';
    }

    const runAttempt = async (attemptChannel: UpdateDownloadChannel) => {
      const endpoint = await resolveDownloadEndpoint(url, attemptChannel, controller.signal);
      recordDiagnostic(
        'info',
        'system',
        `更新包下载通道：${endpoint.nodeLabel} · ${
          endpoint.supportsRange && endpoint.totalBytes >= MIN_PARALLEL_BYTES
            ? `${PARALLEL_SEGMENTS} 线程分片`
            : '单流高速缓冲'
        } (${endpoint.totalBytes ? `${(endpoint.totalBytes / 1048576).toFixed(1)} MB` : '未知大小'})`
      );

      if (endpoint.supportsRange && endpoint.totalBytes >= MIN_PARALLEL_BYTES) {
        try {
          const bytes = await downloadInParallelRanges(
            endpoint.resolvedUrl,
            partPath,
            endpoint.totalBytes,
            endpoint.channel,
            endpoint.nodeLabel,
            safeName,
            controller,
            abortPromise,
            emitProgress
          );
          return { bytes, endpoint, parallel: true };
        } catch (rangeErr) {
          if (controller.signal.aborted) throw rangeErr;
          await fs.unlink(partPath).catch(() => {});
          recordDiagnostic(
            'warn',
            'system',
            `多线程分片下载失败（${
              rangeErr instanceof Error ? rangeErr.message : String(rangeErr)
            }），回退单流高速缓冲下载`
          );
        }
      }

      const bytes = await downloadSingleStream(
        endpoint.resolvedUrl,
        partPath,
        endpoint.totalBytes,
        endpoint.channel,
        endpoint.nodeLabel,
        safeName,
        controller,
        abortPromise,
        emitProgress
      );
      return { bytes, endpoint, parallel: false };
    };

    let result: { bytes: number; endpoint: ResolvedEndpoint; parallel: boolean };
    try {
      result = await runAttempt(channel);
    } catch (firstErr) {
      if (controller.signal.aborted || channel !== 'mirror') {
        throw firstErr;
      }
      await fs.unlink(partPath).catch(() => {});
      recordDiagnostic(
        'warn',
        'system',
        `加速通道下载异常（${
          firstErr instanceof Error ? firstErr.message : String(firstErr)
        }），自动回退官方直连重试`
      );
      result = await runAttempt('direct');
    }

    if (controller.signal.aborted) {
      throw new Error('DOWNLOAD_ABORTED');
    }

    const totalBytes = result.endpoint.totalBytes || result.bytes;
    const finalSourceLabel = `${result.endpoint.nodeLabel} (${
      result.parallel ? `${PARALLEL_SEGMENTS} 线程` : '单流'
    })`;

    let verifiedSha256 = false;
    if (expectedSha256) {
      emitProgress({
        phase: 'verifying',
        percent: 100,
        downloadedBytes: result.bytes,
        totalBytes,
        speedBytesPerSec: 0,
        fileName: safeName,
        channel: result.endpoint.channel,
        sourceLabel: finalSourceLabel,
      });
      const actualSha256 = await computeFileSha256(partPath);
      if (actualSha256 !== expectedSha256) {
        await fs.unlink(partPath).catch(() => {});
        recordDiagnostic(
          'error',
          'system',
          `更新包 SHA-256 校验不匹配！期望 ${expectedSha256.slice(0, 12)}...，实际 ${actualSha256.slice(0, 12)}...`
        );
        throw new Error('SHA-256 校验失败，文件可能已损坏或被篡改，已自动删除，请切换「官方直连」重试');
      }
      verifiedSha256 = true;
    }

    await fs.unlink(finalPath).catch(() => {});
    await fs.rename(partPath, finalPath);
    activeDownloadPartPath = null;
    activeDownloadController = null;

    emitProgress({
      phase: 'completed',
      percent: 100,
      downloadedBytes: result.bytes,
      totalBytes,
      speedBytesPerSec: 0,
      fileName: safeName,
      filePath: finalPath,
      channel: result.endpoint.channel,
      sourceLabel: finalSourceLabel,
      verifiedSha256,
    });
    recordDiagnostic(
      'info',
      'system',
      `更新包下载完成：${safeName}（${finalSourceLabel}${verifiedSha256 ? ' · SHA-256 校验通过' : ''}）`
    );
    return { ok: true, filePath: finalPath, verifiedSha256 };
  } catch (err) {
    await fs.unlink(partPath).catch(() => {});
    const wasAborted = controller.signal.aborted;
    if (activeDownloadController === controller) {
      activeDownloadController = null;
      activeDownloadPartPath = null;
    }
    if (wasAborted) {
      emitProgress({
        phase: 'cancelled',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBytesPerSec: 0,
        fileName: safeName,
        channel,
      });
      return { ok: false, cancelled: true };
    }
    const msg =
      err instanceof Error
        ? err.name === 'AbortError' || err.message === 'REQUEST_TIMEOUT'
          ? '连接下载节点超时，请切换通道重试或点「GitHub 页面」通过浏览器下载'
          : err.message
        : '下载更新失败';
    emitProgress({
      phase: 'error',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBytesPerSec: 0,
      fileName: safeName,
      channel,
      error: msg,
    });
    recordDiagnostic('warn', 'system', `更新包下载失败：${msg}`);
    return { ok: false, error: msg };
  }
}

export async function installDownloadedUpdate(
  filePath: string,
  onQuitForInstaller: () => void
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resolvedTarget = path.resolve(filePath);
    const allowedDir = path.resolve(getUpdateTempDir()) + path.sep;
    if (!resolvedTarget.toLowerCase().startsWith(allowedDir.toLowerCase())) {
      return { ok: false, error: '无效的安装文件路径' };
    }
    if (!existsSync(resolvedTarget)) {
      return { ok: false, error: '安装包不存在，请重新下载' };
    }

    const lower = resolvedTarget.toLowerCase();
    if (lower.endsWith('.exe')) {
      const openErr = await shell.openPath(resolvedTarget);
      if (openErr) {
        return { ok: false, error: `启动安装程序失败：${openErr}` };
      }
      recordDiagnostic(
        'info',
        'system',
        `已启动安装程序并准备退出当前版本：${path.basename(resolvedTarget)}`
      );
      setTimeout(() => {
        onQuitForInstaller();
      }, 650);
      return { ok: true };
    }

    shell.showItemInFolder(resolvedTarget);
    recordDiagnostic('info', 'system', `已定位便携更新包：${path.basename(resolvedTarget)}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '启动更新失败' };
  }
}

export async function openSafeExternalUrl(rawUrl: string): Promise<boolean> {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
}
