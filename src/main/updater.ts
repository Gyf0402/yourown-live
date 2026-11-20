import { app, session, shell } from 'electron';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppUpdateCheckResult,
  UpdateAssetInfo,
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

let activeDownloadController: AbortController | null = null;
let activeDownloadReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let activeDownloadPartPath: string | null = null;

function normalizeVersion(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^v/i, '')
    .split('+')[0];
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
      return u.pathname.toLowerCase().startsWith(`/${GITHUB_OWNER.toLowerCase()}/${GITHUB_REPO.toLowerCase()}/`);
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
} {
  let installerAsset: UpdateAssetInfo | undefined;
  let portableAsset: UpdateAssetInfo | undefined;
  for (const a of assets) {
    const name = typeof a?.name === 'string' ? a.name : '';
    const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
    const size = typeof a?.size === 'number' && Number.isFinite(a.size) ? a.size : 0;
    if (!name || !url) continue;
    const lower = name.toLowerCase();
    if (!installerAsset && lower.endsWith('.exe')) {
      installerAsset = { name, url, size };
    } else if (!portableAsset && lower.endsWith('.zip')) {
      portableAsset = { name, url, size };
    }
  }
  return { installerAsset, portableAsset };
}

function getUpdaterSession() {
  return session.fromPartition('updater');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await getUpdaterSession().fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
        const { installerAsset, portableAsset } = pickAssets(data.assets);
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
  if (activeDownloadReader) {
    const reader = activeDownloadReader;
    activeDownloadReader = null;
    await reader.cancel().catch(() => {});
  }
  if (activeDownloadPartPath) {
    const partPath = activeDownloadPartPath;
    activeDownloadPartPath = null;
    await fs.unlink(partPath).catch(() => {});
  }
}

export async function downloadUpdateAsset(
  url: string,
  fileName: string,
  emitProgress: (progress: UpdateDownloadProgress) => void
): Promise<{ ok: boolean; filePath?: string; cancelled?: boolean; error?: string }> {
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

  emitProgress({
    phase: 'downloading',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speedBytesPerSec: 0,
    fileName: safeName,
  });

  let connectTimedOut = false;
  const connectTimer = setTimeout(() => {
    connectTimedOut = true;
    try {
      controller.abort();
    } catch {
      // Ignore
    }
  }, 18000);

  try {
    const response = await getUpdaterSession().fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': `YourOwn-Live/${app.getVersion()}`,
      },
    });
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      throw new Error(`下载失败（HTTP ${response.status}）`);
    }

    const totalBytes = Number(response.headers.get('content-length') || 0) || 0;
    const fileStream = createWriteStream(partPath);
    const reader = response.body.getReader();
    activeDownloadReader = reader;

    let downloadedBytes = 0;
    let lastEmitTs = Date.now();
    let lastEmitBytes = 0;

    // Immediately inform UI once headers arrive so total size is visible right away
    emitProgress({
      phase: 'downloading',
      percent: 0,
      downloadedBytes: 0,
      totalBytes,
      speedBytesPerSec: 0,
      fileName: safeName,
    });

    try {
      while (true) {
        if (controller.signal.aborted) {
          throw new Error('DOWNLOAD_ABORTED');
        }
        const { done, value } = await reader.read();
        if (controller.signal.aborted) {
          throw new Error('DOWNLOAD_ABORTED');
        }
        if (done) break;
        if (value && value.byteLength > 0) {
          if (!fileStream.write(value)) {
            await new Promise<void>((resolve) => fileStream.once('drain', resolve));
          }
          downloadedBytes += value.byteLength;
          const now = Date.now();
          if (now - lastEmitTs >= 180 && !controller.signal.aborted) {
            const elapsedSec = Math.max(0.05, (now - lastEmitTs) / 1000);
            const speedBytesPerSec = Math.round((downloadedBytes - lastEmitBytes) / elapsedSec);
            const percent =
              totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
            emitProgress({
              phase: 'downloading',
              percent,
              downloadedBytes,
              totalBytes,
              speedBytesPerSec,
              fileName: safeName,
            });
            lastEmitTs = now;
            lastEmitBytes = downloadedBytes;
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.on('error', reject);
        fileStream.end(() => resolve());
      });
    } catch (streamErr) {
      await new Promise<void>((resolve) => {
        fileStream.once('close', () => resolve());
        fileStream.destroy();
        setTimeout(resolve, 120);
      });
      throw streamErr;
    } finally {
      if (activeDownloadReader === reader) {
        activeDownloadReader = null;
      }
    }

    await fs.unlink(finalPath).catch(() => {});
    await fs.rename(partPath, finalPath);
    activeDownloadPartPath = null;
    activeDownloadController = null;

    emitProgress({
      phase: 'completed',
      percent: 100,
      downloadedBytes,
      totalBytes: totalBytes || downloadedBytes,
      speedBytesPerSec: 0,
      fileName: safeName,
      filePath: finalPath,
    });
    recordDiagnostic('info', 'system', `更新包下载完成：${safeName}`);
    return { ok: true, filePath: finalPath };
  } catch (err) {
    clearTimeout(connectTimer);
    await fs.unlink(partPath).catch(() => {});
    const wasAborted = controller.signal.aborted && !connectTimedOut;
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
      });
      return { ok: false, cancelled: true };
    }
    const msg = connectTimedOut
      ? '连接 GitHub 下载节点超时，请重试或点「GitHub 页面」通过浏览器下载'
      : err instanceof Error
        ? err.message
        : '下载更新失败';
    emitProgress({
      phase: 'error',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBytesPerSec: 0,
      fileName: safeName,
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
      recordDiagnostic('info', 'system', `已启动安装程序并准备退出当前版本：${path.basename(resolvedTarget)}`);
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
