import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpCircle,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { PLATFORM_LIST } from '../../shared/platforms';
import type {
  AppUpdateCheckResult,
  AuthStatusMap,
  Channel,
  CodecProbeResult,
  DiagnosticLogEntry,
  PlatformId,
} from '../../shared/types';

interface LoginModalProps {
  bossKeyShortcut: string;
  authStatus: AuthStatusMap;
  channels: Channel[];
  customGroups: string[];
  updateInfo: AppUpdateCheckResult | null;
  checkingUpdate: boolean;
  onCheckUpdate: () => Promise<AppUpdateCheckResult | null>;
  onOpenUpdateModal: () => void;
  onClose: () => void;
  onUpdateBossKey: (shortcut: string) => Promise<{ ok: boolean; error?: string }>;
  onRefreshAuth: () => Promise<void>;
  onClearPlatformCookies: (platform: PlatformId) => Promise<void>;
  onReloadAllPanes: () => void;
  onImportChannels: (imported: Channel[], importedGroups?: string[]) => { added: number; skipped: number };
}

type ModalTab = 'auth' | 'backup' | 'diagnostics';

function probeCodecs(): CodecProbeResult {
  const v = document.createElement('video');
  const h264 = Boolean(v.canPlayType('video/mp4; codecs="avc1.42E01E"'));
  const hevc = Boolean(
    v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
      v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')
  );
  const av1 = Boolean(v.canPlayType('video/mp4; codecs="av01.0.04M.08"'));
  const mseH264 =
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"');
  const mseHevc =
    typeof MediaSource !== 'undefined' &&
    (MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
      MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"'));
  return { h264, hevc, av1, mseH264, mseHevc, userAgent: navigator.userAgent };
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LoginModal({
  bossKeyShortcut,
  authStatus,
  channels,
  customGroups,
  updateInfo,
  checkingUpdate,
  onCheckUpdate,
  onOpenUpdateModal,
  onClose,
  onUpdateBossKey,
  onRefreshAuth,
  onClearPlatformCookies,
  onReloadAllPanes,
  onImportChannels,
}: LoginModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('auth');
  const [shortcutInput, setShortcutInput] = useState(bossKeyShortcut);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [appInfo, setAppInfo] = useState<{
    version: string;
    electron: string;
    chrome: string;
    userDataPath: string;
  } | null>(null);

  const codecInfo = useMemo(() => probeCodecs(), []);

  useEffect(() => {
    void window.livehub.getAppInfo().then(setAppInfo);
    void onRefreshAuth();
    if (typeof window.livehub.getDiagnostics === 'function') {
      void window.livehub.getDiagnostics().then(setLogs);
    }
    const unsub =
      typeof window.livehub.onDiagnosticLog === 'function'
        ? window.livehub.onDiagnosticLog((entry) => {
            setLogs((prev) => [...prev.slice(-119), entry]);
          })
        : () => {};
    return unsub;
  }, [onRefreshAuth]);

  const handleOpenLogin = (platform: PlatformId) => {
    void window.livehub.openPlatformLogin(platform);
    setStatusMsg('已打开登录窗口，扫码登录成功后会自动同步 Cookie 并刷新对应画质。');
  };

  const handleClearCookies = async (platform: PlatformId) => {
    await onClearPlatformCookies(platform);
    setStatusMsg(`已清理 ${platform} Cookie`);
  };

  const handleSaveShortcut = async () => {
    const res = await onUpdateBossKey(shortcutInput);
    if (res.ok) {
      setStatusMsg(`老板键已更新为 ${shortcutInput || '已禁用'}`);
    } else {
      setStatusMsg(res.error || '更新失败');
    }
  };

  const handleExportJson = () => {
    const payload = {
      schema: 'yourown-live-backup-v1',
      exportedAt: new Date().toISOString(),
      customGroups,
      channels,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateTag = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `yourown-live-channels-${dateTag}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg(`已导出 ${channels.length} 个收藏直播间与 ${customGroups.length} 个自定义分组`);
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as
        | Channel[]
        | { channels?: Channel[]; customGroups?: string[] };
      const rawChannels = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.channels)
          ? parsed.channels
          : [];
      const rawGroups = !Array.isArray(parsed) && Array.isArray(parsed?.customGroups)
        ? parsed.customGroups
        : [];
      const validPlatforms = new Set<PlatformId>(['huya', 'douyu', 'bilibili', 'douyin']);
      const validChannels: Channel[] = rawChannels
        .filter(
          (c): c is Channel =>
            Boolean(
              c &&
                typeof c.roomId === 'string' &&
                typeof c.url === 'string' &&
                validPlatforms.has(c.platform)
            )
        )
        .map((c, idx) => ({
          id: c.id || `${c.platform}-${c.roomId}-${Date.now()}-${idx}`,
          platform: c.platform,
          roomId: c.roomId,
          name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `${c.platform} ${c.roomId}`,
          group: typeof c.group === 'string' && c.group.trim() ? c.group.trim() : '综合',
          url: c.url,
          pinned: Boolean(c.pinned),
          remarkLocked: Boolean(c.remarkLocked),
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now() - idx,
        }));
      if (validChannels.length === 0) {
        setStatusMsg('未在文件中找到有效的直播间数据');
        return;
      }
      const res = onImportChannels(validChannels, rawGroups);
      setStatusMsg(`导入完成：新增 ${res.added} 个直播间，跳过已存在 ${res.skipped} 个`);
    } catch {
      setStatusMsg('JSON 文件解析失败，请确认文件格式正确');
    }
  };

  const handleCopyLogs = async () => {
    const text = logs
      .map((l) => `[${formatTime(l.ts)}] [${l.level.toUpperCase()}] [${l.source}] ${l.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text || '（暂无诊断日志）');
      setStatusMsg('诊断日志已复制到剪贴板');
    } catch {
      setStatusMsg('复制失败');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">设置中心 · 账号 / 备份 / 诊断</div>
          <button className="mini-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === 'auth' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('auth');
              setStatusMsg(null);
            }}
          >
            <KeyRound size={13} />
            <span>账号与快捷键</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === 'backup' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('backup');
              setStatusMsg(null);
            }}
          >
            <Download size={13} />
            <span>收藏导入/导出</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === 'diagnostics' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('diagnostics');
              setStatusMsg(null);
            }}
          >
            <Activity size={13} />
            <span>连接诊断 ({logs.length})</span>
          </button>
        </div>

        {activeTab === 'auth' && (
          <>
            <div className="platform-login-grid">
              {PLATFORM_LIST.map((p) => {
                const auth = authStatus[p.id];
                return (
                  <div key={p.id} className="login-card">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                      }}
                    >
                      <span
                        className="platform-badge"
                        style={{ color: p.color, background: p.bgTint, fontSize: 12 }}
                      >
                        {p.name}
                      </span>
                      <span className={`auth-status-tag ${auth?.loggedIn ? 'online' : 'offline'}`}>
                        {auth?.loggedIn
                          ? `已登录${auth.accountHint ? ` · ${auth.accountHint}` : ''}`
                          : '未登录 · 游客画质'}
                      </span>
                    </div>
                    <div className="login-card-actions">
                      <button
                        className="primary-btn"
                        style={{ flex: 1, height: 29 }}
                        onClick={() => handleOpenLogin(p.id)}
                      >
                        <ExternalLink size={12} />
                        <span>{auth?.loggedIn ? '切换 / 续期登录' : '扫码 / 账号登录'}</span>
                      </button>
                      {auth?.loggedIn && (
                        <button
                          className="icon-btn danger"
                          style={{ height: 29 }}
                          onClick={() => void handleClearCookies(p.id)}
                          title="退出并清理该平台 Cookie"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <button
                className="icon-btn"
                onClick={() => {
                  onReloadAllPanes();
                  setStatusMsg('已通知所有正在播放的分屏刷新加载最新高画质。');
                }}
              >
                <RefreshCw size={13} />
                <span>立即刷新在播分屏</span>
              </button>
              <button
                className="icon-btn"
                onClick={() =>
                  void onRefreshAuth().then(() => setStatusMsg('已重新检测四平台登录状态。'))
                }
              >
                <span>重新检测登录态</span>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                全局老板键：
              </span>
              <input
                className="text-input"
                value={shortcutInput}
                onChange={(e) => setShortcutInput(e.target.value)}
                placeholder="例如 Alt+X 或 Ctrl+Shift+H"
              />
              <button className="primary-btn" onClick={() => void handleSaveShortcut()}>
                应用
              </button>
            </div>

            <div className="update-settings-row">
              <div className="update-settings-info">
                <span className="update-settings-ver">
                  当前版本：<strong>v{appInfo?.version || updateInfo?.currentVersion || '0.1.5'}</strong>
                </span>
                {updateInfo?.hasUpdate && updateInfo.latestVersion ? (
                  <span className="update-settings-badge has-update">
                    发现新版本 v{updateInfo.latestVersion}
                  </span>
                ) : updateInfo?.ok ? (
                  <span className="update-settings-badge up-to-date">已是最新版</span>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {updateInfo?.hasUpdate && (
                  <button
                    type="button"
                    className="primary-btn"
                    style={{ height: 29 }}
                    onClick={onOpenUpdateModal}
                  >
                    <ArrowUpCircle size={13} />
                    <span>查看更新</span>
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  style={{ height: 29 }}
                  disabled={checkingUpdate}
                  onClick={() => {
                    void onCheckUpdate().then((res) => {
                      if (!res) return;
                      if (!res.ok) {
                        setStatusMsg(`检查更新失败：${res.error || '网络异常'}`);
                      } else if (res.hasUpdate && res.latestVersion) {
                        setStatusMsg(`发现新版本 v${res.latestVersion}！`);
                        onOpenUpdateModal();
                      } else {
                        setStatusMsg(`当前 v${res.currentVersion} 已是最新版本。`);
                      }
                    });
                  }}
                >
                  <RefreshCw size={12} className={checkingUpdate ? 'spin-icon' : ''} />
                  <span>{checkingUpdate ? '检查中...' : '检查更新'}</span>
                </button>
              </div>
            </div>

            <div className="info-box">
              <div>• 快捷键：`1`~`4` 切对应分屏独听 · `M` 静音当前屏 · `R` 刷新当前屏 · `Tab` 切焦点 · `Esc` 还原临时放大 · 滚轮调音量。</div>
              <div>• 登录 Cookie 本地持久化在 `persist:livehub`，所有分屏与 B站直连弹幕共享。</div>
              {appInfo && (
                <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
                  Electron {appInfo.electron} · Chromium {appInfo.chrome} · 数据目录：{appInfo.userDataPath}
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'backup' && (
          <div className="modal-section-stack">
            <div className="info-box">
              <div>• 当前共有 <strong>{channels.length}</strong> 个收藏直播间、<strong>{customGroups.length}</strong> 个自定义分组。</div>
              <div>• 导出文件为标准 JSON，导入时会自动按「平台 + 房间号」去重合并，不会覆盖已有备注。</div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="primary-btn" style={{ flex: 1, height: 36 }} onClick={handleExportJson}>
                <Download size={14} />
                <span>导出收藏列表 JSON</span>
              </button>
              <button
                className="icon-btn"
                style={{ flex: 1, height: 36, borderRadius: 10 }}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={14} />
                <span>从 JSON 导入合并</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        )}

        {activeTab === 'diagnostics' && (
          <div className="modal-section-stack">
            <div className="diag-codec-grid">
              <div className={`diag-pill ${codecInfo.mseH264 ? 'ok' : 'bad'}`}>
                MSE H.264: {codecInfo.mseH264 ? '支持' : '不支持'}
              </div>
              <div className={`diag-pill ${codecInfo.mseHevc ? 'ok' : 'warn'}`}>
                MSE HEVC: {codecInfo.mseHevc ? '支持' : '未启用'}
              </div>
              <div className={`diag-pill ${codecInfo.av1 ? 'ok' : 'warn'}`}>
                AV1 解码: {codecInfo.av1 ? '支持' : '不支持'}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                最近抓流与弹幕连接事件（最多保留 120 条）
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="icon-btn" onClick={() => void handleCopyLogs()}>
                  <Copy size={12} />
                  <span>复制</span>
                </button>
                <button
                  className="icon-btn danger"
                  onClick={() => {
                    void window.livehub.clearDiagnostics?.();
                    setLogs([]);
                    setStatusMsg('已清空诊断日志');
                  }}
                >
                  <Trash2 size={12} />
                  <span>清空</span>
                </button>
              </div>
            </div>

            <div className="diag-log-list">
              {logs.length === 0 ? (
                <div className="diag-log-empty">暂无诊断记录</div>
              ) : (
                [...logs].reverse().map((entry) => (
                  <div key={entry.id} className={`diag-log-row level-${entry.level}`}>
                    <span className="diag-log-time">{formatTime(entry.ts)}</span>
                    <span className="diag-log-src">{entry.source}</span>
                    <span className="diag-log-msg">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {statusMsg && (
          <div style={{ fontSize: 12, color: 'var(--success)', fontWeight: 500 }}>{statusMsg}</div>
        )}
      </div>
    </div>
  );
}
