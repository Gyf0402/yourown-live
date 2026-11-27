import { Fragment, useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Package,
  RefreshCw,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import type {
  AppUpdateCheckResult,
  UpdateAssetInfo,
  UpdateDownloadChannel,
  UpdateDownloadProgress,
} from '../../shared/types';

const UPDATE_CHANNEL_STORAGE_KEY = 'yourownlive:update-channel';

function readStoredChannel(): UpdateDownloadChannel {
  try {
    const raw = window.localStorage.getItem(UPDATE_CHANNEL_STORAGE_KEY);
    if (raw === 'direct' || raw === 'mirror') return raw;
  } catch {
    // Ignore storage errors
  }
  return 'mirror';
}

interface UpdateModalProps {
  updateInfo: AppUpdateCheckResult;
  checking: boolean;
  onClose: () => void;
  onRecheck: () => Promise<void>;
  onIgnoreVersion: (version: string) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*`[^`]+`\*\*|\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    const token = match[0];
    if (token.startsWith('**`') && token.endsWith('`**')) {
      parts.push(
        <strong key={key++}>
          <code className="update-inline-code">{token.slice(3, -3)}</code>
        </strong>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={key++} className="update-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }
  return parts;
}

function ReleaseNotesBlock({ notes }: { notes?: string }) {
  const raw = (notes || '').trim();
  if (!raw) {
    return <div className="update-notes-empty">暂无详细更新说明，可前往 GitHub Release 页面查看。</div>;
  }
  const lines = raw.split(/\r?\n/);
  return (
    <div className="update-notes-body">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={idx} className="update-notes-spacer" />;
        if (/^#{1,3}\s+/.test(trimmed)) {
          return (
            <div key={idx} className="update-notes-heading">
              {renderInlineMarkdown(trimmed.replace(/^#{1,3}\s+/, ''))}
            </div>
          );
        }
        if (/^>\s*/.test(trimmed)) {
          return (
            <div key={idx} className="update-notes-quote">
              {renderInlineMarkdown(trimmed.replace(/^>\s*/, ''))}
            </div>
          );
        }
        const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
        if (bulletMatch) {
          const indent = bulletMatch[1].length >= 2;
          return (
            <div key={idx} className={`update-notes-bullet ${indent ? 'nested' : ''}`}>
              <span className="update-bullet-dot">•</span>
              <span>{renderInlineMarkdown(bulletMatch[2])}</span>
            </div>
          );
        }
        return (
          <div key={idx} className="update-notes-line">
            {renderInlineMarkdown(trimmed)}
          </div>
        );
      })}
    </div>
  );
}

export function UpdateModal({
  updateInfo,
  checking,
  onClose,
  onRecheck,
  onIgnoreVersion,
}: UpdateModalProps) {
  const [downloadChannel, setDownloadChannel] = useState<UpdateDownloadChannel>(() =>
    readStoredChannel()
  );
  const [downloadState, setDownloadState] = useState<UpdateDownloadProgress>({
    phase: 'idle',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speedBytesPerSec: 0,
  });
  const [actionHint, setActionHint] = useState<string | null>(null);

  const handleChangeChannel = (next: UpdateDownloadChannel) => {
    setDownloadChannel(next);
    try {
      window.localStorage.setItem(UPDATE_CHANNEL_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
  };

  useEffect(() => {
    if (typeof window.livehub?.onUpdateDownloadProgress !== 'function') return;
    return window.livehub.onUpdateDownloadProgress((progress) => {
      setDownloadState(progress);
    });
  }, []);

  const isDownloading = downloadState.phase === 'downloading';
  const isVerifying = downloadState.phase === 'verifying';
  const isBusy = isDownloading || isVerifying;
  const isCompleted = downloadState.phase === 'completed' && Boolean(downloadState.filePath);
  const completedIsExe = Boolean(downloadState.filePath?.toLowerCase().endsWith('.exe'));

  const primaryAsset: UpdateAssetInfo | undefined = updateInfo.isPortableInstall
    ? updateInfo.portableAsset || updateInfo.installerAsset
    : updateInfo.installerAsset || updateInfo.portableAsset;
  const secondaryAsset: UpdateAssetInfo | undefined = updateInfo.isPortableInstall
    ? updateInfo.installerAsset
    : updateInfo.portableAsset;

  const startDownload = async (asset: UpdateAssetInfo) => {
    if (isBusy) return;
    setActionHint(null);
    const res = await window.livehub.downloadUpdate(asset.url, asset.name, {
      channel: downloadChannel,
      expectedSha256: asset.sha256,
      checksumsUrl: updateInfo.checksumsUrl,
    });
    if (!res.ok && !res.cancelled) {
      setActionHint(res.error || '下载失败，请切换下载通道或前往 GitHub Release 页面手动下载');
    }
  };

  const handleCancelDownload = async () => {
    setDownloadState((prev) => ({ ...prev, phase: 'cancelled', speedBytesPerSec: 0 }));
    await window.livehub.cancelUpdateDownload();
    setActionHint('已取消下载');
  };

  const handleInstall = async () => {
    if (!downloadState.filePath) return;
    const res = await window.livehub.installDownloadedUpdate(downloadState.filePath);
    if (!res.ok) {
      setActionHint(res.error || '启动安装程序失败');
    } else if (completedIsExe) {
      setActionHint('正在启动安装向导并退出当前版本...');
    } else {
      setActionHint('已在文件资源管理器中打开下载的便携更新包，解压覆盖旧目录即可升级');
    }
  };

  const handleOpenReleasePage = () => {
    void window.livehub.openExternalUrl(updateInfo.releaseUrl);
  };

  const handleCloseSafely = () => {
    if (isBusy) {
      void window.livehub.cancelUpdateDownload();
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={handleCloseSafely}>
      <div className="modal-card modal-card-wide update-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="update-modal-title-row">
            {updateInfo.hasUpdate ? (
              <ArrowUpCircle size={18} className="update-icon-accent" />
            ) : (
              <CheckCircle2 size={18} className="update-icon-ok" />
            )}
            <div className="modal-title">
              {updateInfo.hasUpdate ? '发现新版本 · YourOwn Live' : '检查更新 · YourOwn Live'}
            </div>
          </div>
          <button className="mini-btn" onClick={handleCloseSafely} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="update-version-banner">
          <div className="update-version-flow">
            <span className="update-ver-pill current">当前 v{updateInfo.currentVersion}</span>
            {updateInfo.latestVersion && (
              <>
                <ArrowRight size={14} className="update-ver-arrow" />
                <span className={`update-ver-pill ${updateInfo.hasUpdate ? 'latest' : 'current'}`}>
                  最新 v{updateInfo.latestVersion}
                </span>
              </>
            )}
          </div>
          {updateInfo.publishedAt && (
            <span className="update-publish-date">发布于 {formatDate(updateInfo.publishedAt)}</span>
          )}
        </div>

        {!updateInfo.ok ? (
          <div className="info-box">
            <div>检查更新失败：{updateInfo.error || '网络异常'}</div>
            <div style={{ marginTop: 4 }}>
              你可以点击下方「重新检查」，或直接前往 GitHub Releases 页面查看最新版本。
            </div>
          </div>
        ) : !updateInfo.hasUpdate ? (
          <div className="info-box">
            <div>当前运行的 <strong>v{updateInfo.currentVersion}</strong> 已经是最新版本，无需更新。</div>
            {updateInfo.releaseNotes && (
              <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                最新正式版：{updateInfo.releaseName || `v${updateInfo.latestVersion}`}
              </div>
            )}
          </div>
        ) : (
          <>
            <ReleaseNotesBlock notes={updateInfo.releaseNotes} />

            <div className="update-safe-tip">
              <ShieldCheck size={14} />
              <span>
                覆盖安装或解压替换均会完整保留你的收藏主播、自定义分组、偏好设置与四平台登录状态。
              </span>
            </div>

            {!isCompleted && (
              <div className="update-channel-row">
                <div className="update-channel-switch" role="radiogroup" aria-label="下载通道">
                  <button
                    type="button"
                    className={`update-channel-btn ${downloadChannel === 'mirror' ? 'active' : ''}`}
                    disabled={isBusy}
                    onClick={() => handleChangeChannel('mirror')}
                    title="多镜像自动竞速 + 6 线程分片下载，下载完成后严格比对官方 SHA-256 校验和防篡改"
                  >
                    <Zap size={12} />
                    <span>加速通道</span>
                  </button>
                  <button
                    type="button"
                    className={`update-channel-btn ${downloadChannel === 'direct' ? 'active' : ''}`}
                    disabled={isBusy}
                    onClick={() => handleChangeChannel('direct')}
                    title="直接连接 GitHub 官方 CDN 并启用 6 线程分片下载（自动遵循系统代理）"
                  >
                    <Globe size={12} />
                    <span>官方直连</span>
                  </button>
                </div>
                <span className="update-channel-hint">
                  {downloadChannel === 'mirror'
                    ? '多节点竞速 · 6 线程分片 · 官方 SHA-256 校验防篡改'
                    : '直连 GitHub CDN · 6 线程分片 · 自动校验 SHA-256'}
                </span>
              </div>
            )}
          </>
        )}

        {(isBusy || isCompleted || downloadState.phase === 'error') && (
          <div className="update-progress-box">
            <div className="update-progress-meta">
              <span className="update-progress-name">
                {isDownloading
                  ? `正在下载 ${downloadState.fileName || '更新包'}${
                      downloadState.sourceLabel ? ` · ${downloadState.sourceLabel}` : ''
                    }`
                  : isVerifying
                    ? `正在校验官方 SHA-256 完整性...`
                    : isCompleted
                      ? `下载完成：${downloadState.fileName || '更新包'}${
                          downloadState.verifiedSha256 ? ' · SHA-256 校验通过' : ''
                        }`
                      : `下载中断：${downloadState.error || '请切换通道重试或前往 GitHub 页面下载'}`}
              </span>
              {isDownloading && (
                <span className="update-progress-stats">
                  {downloadState.totalBytes > 0
                    ? `${downloadState.percent}% · ${formatBytes(downloadState.downloadedBytes)} / ${formatBytes(
                        downloadState.totalBytes
                      )}`
                    : downloadState.downloadedBytes > 0
                      ? formatBytes(downloadState.downloadedBytes)
                      : '正在连接下载节点...'}
                  {downloadState.speedBytesPerSec > 0
                    ? ` · ${formatBytes(downloadState.speedBytesPerSec)}/s`
                    : ''}
                </span>
              )}
              {isVerifying && <span className="update-progress-stats">100% · 安全校验中</span>}
            </div>
            <div className="update-progress-track">
              <div
                className={`update-progress-fill ${isCompleted ? 'done' : ''} ${
                  downloadState.phase === 'error' ? 'err' : ''
                }`}
                style={{
                  width: `${
                    isCompleted || isVerifying
                      ? 100
                      : downloadState.totalBytes > 0
                        ? Math.max(4, downloadState.percent)
                        : isDownloading
                          ? 20
                          : 0
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        {actionHint && (
          <div
            style={{
              fontSize: 12,
              color: downloadState.phase === 'error' ? 'var(--danger)' : 'var(--success)',
              fontWeight: 500,
            }}
          >
            {actionHint}
          </div>
        )}

        <div className="update-modal-actions">
          <div className="update-modal-actions-left">
            {updateInfo.hasUpdate && updateInfo.latestVersion && !isBusy && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  onIgnoreVersion(updateInfo.latestVersion!);
                  onClose();
                }}
                title="不再在顶部提示此版本（仍可在设置中心手动检查）"
              >
                <span>忽略此版本</span>
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={handleOpenReleasePage}
              title="在默认浏览器中打开 GitHub Releases 页面"
            >
              <ExternalLink size={13} />
              <span>GitHub 页面</span>
            </button>
            {!updateInfo.hasUpdate && (
              <button
                type="button"
                className="icon-btn"
                disabled={checking}
                onClick={() => void onRecheck()}
              >
                <RefreshCw size={13} className={checking ? 'spin-icon' : ''} />
                <span>{checking ? '检查中...' : '重新检查'}</span>
              </button>
            )}
          </div>

          <div className="update-modal-actions-right">
            {isBusy ? (
              <button
                type="button"
                className="icon-btn danger"
                disabled={isVerifying}
                onClick={() => void handleCancelDownload()}
              >
                <span>{isVerifying ? '校验中...' : '取消下载'}</span>
              </button>
            ) : isCompleted ? (
              <button type="button" className="primary-btn" onClick={() => void handleInstall()}>
                {completedIsExe ? <Download size={13} /> : <FolderOpen size={13} />}
                <span>{completedIsExe ? '立即安装并退出' : '打开所在文件夹'}</span>
              </button>
            ) : (
              updateInfo.hasUpdate && (
                <>
                  {secondaryAsset && secondaryAsset.url !== primaryAsset?.url && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => void startDownload(secondaryAsset)}
                      title={`下载 ${secondaryAsset.name}${
                        secondaryAsset.size ? ` (${formatBytes(secondaryAsset.size)})` : ''
                      }`}
                    >
                      <Package size={13} />
                      <span>
                        {secondaryAsset.name.toLowerCase().endsWith('.zip') ? '绿色便携版' : '安装版'}
                      </span>
                    </button>
                  )}
                  {primaryAsset && (
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => void startDownload(primaryAsset)}
                      title={`下载 ${primaryAsset.name}${
                        primaryAsset.size ? ` (${formatBytes(primaryAsset.size)})` : ''
                      }`}
                    >
                      <Download size={13} />
                      <span>
                        {primaryAsset.name.toLowerCase().endsWith('.exe')
                          ? `一键下载安装${primaryAsset.size ? ` (${formatBytes(primaryAsset.size)})` : ''}`
                          : `下载便携版${primaryAsset.size ? ` (${formatBytes(primaryAsset.size)})` : ''}`}
                      </span>
                    </button>
                  )}
                </>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
