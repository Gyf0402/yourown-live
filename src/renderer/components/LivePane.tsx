import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpLeft,
  Globe,
  GripVertical,
  Headphones,
  KeyRound,
  Maximize2,
  Minimize2,
  RefreshCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { PLATFORM_LIST, PLATFORMS, parseLiveInput } from '../../shared/platforms';
import type {
  Channel,
  DanmakuArea,
  DanmakuMessage,
  DanmakuMode,
  DanmakuStatusEvent,
  DirectStreamResult,
  PaneSlot,
  PaneViewMode,
  PlatformId,
  StreamOptionsInfo,
  VideoFitMode,
  WebviewPurifyConfig,
} from '../../shared/types';
import type { WebviewElement } from '../env';
import { DirectPlayer } from './DirectPlayer';

interface LivePaneProps {
  pane: PaneSlot;
  isActive: boolean;
  isSolo: boolean;
  isMaximized: boolean;
  canMaximize: boolean;
  isHiddenByMaximize: boolean;
  effectiveMuted: boolean;
  isPlatformLoggedIn: boolean;
  platformReloadEpoch: number;
  slotReloadTick: number;
  channels: Channel[];
  webviewPreloadPath: string;
  autoHighestQuality: boolean;
  hideGiftEffects: boolean;
  danmakuEnabled: boolean;
  danmakuArea: DanmakuArea;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuSpeed: number;
  danmakuMode: DanmakuMode;
  danmakuBlockKeywords: string[];
  onChangeDanmakuArea: (area: DanmakuArea) => void;
  onChangeDanmakuOpacity: (opacity: number) => void;
  onChangeDanmakuFontSize: (size: number) => void;
  onChangeDanmakuSpeed: (speed: number) => void;
  onChangeDanmakuMode: (mode: DanmakuMode) => void;
  onChangeDanmakuBlockKeywords: (keywords: string[]) => void;
  onUpdatePanePrefs: (
    slotIndex: number,
    patch: Partial<
      Pick<PaneSlot, 'volume' | 'fitMode' | 'preferredQualityId' | 'preferredLineId' | 'danmakuEnabled'>
    >
  ) => void;
  onToggleMaximize: (slotIndex: number) => void;
  onSelectPane: (slotIndex: number) => void;
  onLoadUrlInPane: (slotIndex: number, url: string, title?: string, channelId?: string | null) => void;
  onLoadChannelInPane: (slotIndex: number, channel: Channel) => void;
  onToggleMute: (slotIndex: number) => void;
  onToggleSolo: (slotIndex: number) => void;
  onToggleMode: (slotIndex: number, mode: PaneViewMode) => void;
  onUpdateTitle: (slotIndex: number, title: string) => void;
  onClearPane: (slotIndex: number) => void;
  onSwapPanes: (fromSlot: number, toSlot: number) => void;
  onLoginPlatform: (platform: PlatformId) => void;
}

export const LivePane = memo(function LivePane({
  pane,
  isActive,
  isSolo,
  isMaximized,
  canMaximize,
  isHiddenByMaximize,
  effectiveMuted,
  isPlatformLoggedIn,
  platformReloadEpoch,
  slotReloadTick,
  channels,
  webviewPreloadPath,
  autoHighestQuality,
  hideGiftEffects,
  danmakuEnabled,
  danmakuArea,
  danmakuOpacity,
  danmakuFontSize,
  danmakuSpeed,
  danmakuMode,
  danmakuBlockKeywords,
  onChangeDanmakuArea,
  onChangeDanmakuOpacity,
  onChangeDanmakuFontSize,
  onChangeDanmakuSpeed,
  onChangeDanmakuMode,
  onChangeDanmakuBlockKeywords,
  onUpdatePanePrefs,
  onToggleMaximize,
  onSelectPane,
  onLoadUrlInPane,
  onLoadChannelInPane,
  onToggleMute,
  onToggleSolo,
  onToggleMode,
  onUpdateTitle,
  onClearPane,
  onSwapPanes,
  onLoginPlatform,
}: LivePaneProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [domReady, setDomReady] = useState(false);
  const [isLoading, setIsLoading] = useState(Boolean(pane.url));
  const [mountReady, setMountReady] = useState(pane.slotIndex === 0);
  const [dragOver, setDragOver] = useState(false);
  const [quickInput, setQuickInput] = useState('');
  const [quickPendingRoomId, setQuickPendingRoomId] = useState<string | null>(null);
  const [quickResolving, setQuickResolving] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [streamOptions, setStreamOptions] = useState<StreamOptionsInfo>({
    qualities: [],
    lines: [],
  });
  const [probing, setProbing] = useState(false);
  const [paneHint, setPaneHint] = useState<string | null>(null);
  const [directStream, setDirectStream] = useState<DirectStreamResult | null>(null);
  const [directReloadTick, setDirectReloadTick] = useState(0);
  const [directStats, setDirectStats] = useState<{
    protocol: 'FLV' | 'HLS';
    latencySec: number | null;
    resolution?: string;
  } | null>(null);
  const [directPlayError, setDirectPlayError] = useState<string | null>(null);
  const [danmakuBatch, setDanmakuBatch] = useState<DanmakuMessage[]>([]);
  const [danmakuStatus, setDanmakuStatus] = useState<DanmakuStatusEvent | null>(null);
  const autoRetryCountRef = useRef(0);
  const triedLinesRef = useRef<Set<string>>(new Set());
  const retryTimerRef = useRef<number | null>(null);
  const onUpdateTitleRef = useRef(onUpdateTitle);
  onUpdateTitleRef.current = onUpdateTitle;
  const lastEpochRef = useRef(platformReloadEpoch);
  const lastSlotReloadRef = useRef(slotReloadTick);

  const directQualityId = pane.preferredQualityId;
  const directLineId = pane.preferredLineId;
  const localDanmakuOn = pane.danmakuEnabled ?? danmakuEnabled;
  const paneVolume = pane.volume ?? 1;
  const paneFitMode: VideoFitMode = pane.fitMode ?? 'contain';

  const platformMeta = pane.platform ? PLATFORMS[pane.platform] : null;

  const parsedTarget = useMemo(() => {
    if (!pane.url) return null;
    const parsed = parseLiveInput(pane.url, pane.platform ?? undefined);
    return parsed.ok ? { platform: parsed.platform, roomId: parsed.roomId } : null;
  }, [pane.url, pane.platform]);

  const useDirectStream = Boolean(
    pane.url &&
      pane.mode === 'pure' &&
      parsedTarget &&
      typeof window !== 'undefined' &&
      typeof window.livehub?.resolveStream === 'function'
  );

  const showTempHint = useCallback((msg: string) => {
    setPaneHint(msg);
    window.setTimeout(() => {
      setPaneHint((cur) => (cur === msg ? null : cur));
    }, 2600);
  }, []);

  // Stagger initial multi-pane webview mounts slightly to avoid cold-start CPU/network spikes
  useEffect(() => {
    if (mountReady) return;
    const timer = window.setTimeout(() => setMountReady(true), pane.slotIndex * 260);
    return () => window.clearTimeout(timer);
  }, [mountReady, pane.slotIndex]);

  // Reset transient state when URL changes
  useEffect(() => {
    setDomReady(false);
    setIsLoading(Boolean(pane.url));
    setProbing(false);
    setPaneHint(null);
    setStreamOptions({ qualities: [], lines: [] });
    setDirectStream(null);
    setDirectStats(null);
    setDirectPlayError(null);
    setDanmakuBatch([]);
    setDanmakuStatus(null);
    autoRetryCountRef.current = 0;
    triedLinesRef.current = new Set();
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [pane.url]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  // Respond to keyboard-triggered slot reload
  useEffect(() => {
    if (slotReloadTick === lastSlotReloadRef.current) return;
    lastSlotReloadRef.current = slotReloadTick;
    if (!pane.url) return;
    if (useDirectStream) {
      autoRetryCountRef.current = 0;
      triedLinesRef.current = new Set();
      setDirectPlayError(null);
      setDirectReloadTick((n) => n + 1);
    } else if (webviewRef.current) {
      try {
        webviewRef.current.reload();
      } catch {
        // Ignore
      }
    }
  }, [slotReloadTick, pane.url, useDirectStream]);

  // Subscribe to native main-process WebSocket danmaku batches & status for this slot
  useEffect(() => {
    if (
      !useDirectStream ||
      !localDanmakuOn ||
      !directStream?.ok ||
      !parsedTarget ||
      typeof window.livehub?.startDanmaku !== 'function'
    ) {
      setDanmakuBatch([]);
      setDanmakuStatus(null);
      if (typeof window.livehub?.stopDanmaku === 'function') {
        void window.livehub.stopDanmaku(pane.slotIndex);
      }
      return;
    }

    const unsubBatch = window.livehub.onDanmakuBatch((batch) => {
      const mine = batch.filter((m) => m.slotIndex === pane.slotIndex);
      if (mine.length > 0) {
        setDanmakuBatch(mine);
      }
    });

    const unsubStatus =
      typeof window.livehub.onDanmakuStatus === 'function'
        ? window.livehub.onDanmakuStatus((ev) => {
            if (ev.slotIndex === pane.slotIndex) {
              setDanmakuStatus(ev);
            }
          })
        : () => {};

    void window.livehub.startDanmaku(pane.slotIndex, parsedTarget.platform, parsedTarget.roomId);

    return () => {
      unsubBatch();
      unsubStatus();
      setDanmakuBatch([]);
      setDanmakuStatus(null);
      void window.livehub.stopDanmaku(pane.slotIndex);
    };
  }, [
    useDirectStream,
    localDanmakuOn,
    directStream?.ok,
    parsedTarget?.platform,
    parsedTarget?.roomId,
    pane.slotIndex,
  ]);

  // Direct low-latency FLV/HLS stream extraction when in Pure (Direct) mode
  useEffect(() => {
    if (!useDirectStream || !parsedTarget) return;
    let cancelled = false;
    setIsLoading(true);
    setDirectPlayError(null);

    void window.livehub
      .resolveStream({
        platform: parsedTarget.platform,
        roomId: parsedTarget.roomId,
        qualityId: directQualityId,
        lineId: directLineId,
        autoHighestQuality,
      })
      .then((res) => {
        if (cancelled) return;
        setDirectStream(res);
        setStreamOptions({ qualities: res.qualities || [], lines: res.lines || [] });
        if (res.anchorName || res.title) {
          const displayTitle = res.anchorName
            ? res.title && res.title !== res.anchorName
              ? `${res.anchorName} · ${res.title}`
              : res.anchorName
            : res.title || '';
          if (displayTitle) {
            onUpdateTitleRef.current(pane.slotIndex, displayTitle);
          }
        }
        if (!res.ok) {
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setDirectStream({
          ok: false,
          platform: parsedTarget.platform,
          roomId: parsedTarget.roomId,
          status: 'error',
          referer: '',
          qualities: [],
          lines: [],
          error: err instanceof Error ? err.message : '抓流请求失败',
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    useDirectStream,
    parsedTarget?.platform,
    parsedTarget?.roomId,
    directQualityId,
    directLineId,
    autoHighestQuality,
    directReloadTick,
    platformReloadEpoch,
    pane.slotIndex,
  ]);

  // Attach Electron webview lifecycle & IPC listeners (only when in Web mode)
  useEffect(() => {
    const el = webviewRef.current;
    if (useDirectStream || !el || !pane.url || !webviewPreloadPath || !mountReady) return;

    const handleStartLoading = () => {
      setIsLoading(true);
    };

    const handleStopLoading = () => {
      setIsLoading(false);
    };

    const handleDomReady = () => {
      setDomReady(true);
      setIsLoading(false);
      try {
        el.setAudioMuted(effectiveMuted);
        const cfg: WebviewPurifyConfig = {
          mode: pane.mode,
          autoHighestQuality,
          hideGiftEffects,
          danmakuEnabled,
        };
        el.send('livehub:config', cfg);
        window.setTimeout(() => {
          try {
            const rect = el.getBoundingClientRect();
            void window.livehub.wakeWebview(el.getWebContentsId(), rect.width, rect.height);
          } catch {
            // Ignore
          }
        }, 1600);
      } catch {
        // Ignore transient webview attach errors
      }
    };

    const handleMediaPlay = () => {
      setIsLoading(false);
      try {
        el.setAudioMuted(effectiveMuted);
      } catch {
        // Ignore
      }
    };

    const handleIpcMessage = (event: Event) => {
      const ipcEvent = event as CustomEvent & { channel?: string; args?: unknown[] };
      if (ipcEvent.channel === 'livehub:meta' && Array.isArray(ipcEvent.args) && ipcEvent.args[0]) {
        const meta = ipcEvent.args[0] as { title?: string; hasVideo?: boolean };
        if (meta.title && meta.title.trim()) {
          onUpdateTitle(pane.slotIndex, meta.title.trim());
        }
        if (meta.hasVideo) {
          setIsLoading(false);
        }
      } else if (
        ipcEvent.channel === 'livehub:stream-options' &&
        Array.isArray(ipcEvent.args) &&
        ipcEvent.args[0]
      ) {
        const info = ipcEvent.args[0] as StreamOptionsInfo;
        const qualities = Array.isArray(info.qualities) ? info.qualities : [];
        const lines = Array.isArray(info.lines) ? info.lines : [];
        setStreamOptions({ qualities, lines });
        setProbing(false);
        if (qualities.length > 0 || lines.length > 0) {
          setPaneHint(null);
        }
      }
    };

    el.addEventListener('did-start-loading', handleStartLoading);
    el.addEventListener('did-stop-loading', handleStopLoading);
    el.addEventListener('did-finish-load', handleStopLoading);
    el.addEventListener('did-fail-load', handleStopLoading);
    el.addEventListener('dom-ready', handleDomReady);
    el.addEventListener('media-started-playing', handleMediaPlay);
    el.addEventListener('ipc-message', handleIpcMessage);

    return () => {
      el.removeEventListener('did-start-loading', handleStartLoading);
      el.removeEventListener('did-stop-loading', handleStopLoading);
      el.removeEventListener('did-finish-load', handleStopLoading);
      el.removeEventListener('did-fail-load', handleStopLoading);
      el.removeEventListener('dom-ready', handleDomReady);
      el.removeEventListener('media-started-playing', handleMediaPlay);
      el.removeEventListener('ipc-message', handleIpcMessage);
    };
  }, [useDirectStream, pane.url, pane.slotIndex, webviewPreloadPath, mountReady]);

  // Keep mute state synced after domReady
  useEffect(() => {
    const el = webviewRef.current;
    if (!el || !domReady) return;
    try {
      el.setAudioMuted(effectiveMuted);
    } catch {
      // Ignore if guest is navigating
    }
  }, [effectiveMuted, domReady]);

  // Keep purification config synced after domReady
  useEffect(() => {
    const el = webviewRef.current;
    if (!el || !domReady) return;
    try {
      const cfg: WebviewPurifyConfig = {
        mode: pane.mode,
        autoHighestQuality,
        hideGiftEffects,
        danmakuEnabled,
      };
      el.send('livehub:config', cfg);
    } catch {
      // Ignore
    }
  }, [pane.mode, autoHighestQuality, hideGiftEffects, danmakuEnabled, domReady]);

  // Auto-reload webview when platform login status changes or manual refresh triggered
  useEffect(() => {
    if (platformReloadEpoch === lastEpochRef.current) return;
    lastEpochRef.current = platformReloadEpoch;
    const el = webviewRef.current;
    if (el && pane.url && domReady) {
      try {
        el.reload();
      } catch {
        // Ignore
      }
    }
  }, [platformReloadEpoch, pane.url, domReady]);

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (quickResolving) return;
    const syncRes = parseLiveInput(quickInput);
    if (syncRes.ok) {
      setQuickError(null);
      setQuickPendingRoomId(null);
      setQuickInput('');
      onLoadUrlInPane(
        pane.slotIndex,
        syncRes.url,
        syncRes.suggestedName || `${PLATFORMS[syncRes.platform].shortName} ${syncRes.roomId}`,
        null
      );
      return;
    }

    if (syncRes.needsShortResolve && window.livehub?.resolveLiveInput) {
      setQuickResolving(true);
      setQuickError(syncRes.reason);
      try {
        const resolved = await window.livehub.resolveLiveInput(quickInput);
        if (resolved.ok && resolved.platform && resolved.roomId && resolved.url) {
          setQuickError(null);
          setQuickPendingRoomId(null);
          setQuickInput('');
          onLoadUrlInPane(
            pane.slotIndex,
            resolved.url,
            resolved.suggestedName || `${PLATFORMS[resolved.platform].shortName} ${resolved.roomId}`,
            null
          );
          return;
        }
        if (resolved.needsPlatform && resolved.roomId) {
          setQuickPendingRoomId(resolved.roomId);
        }
        setQuickError(resolved.reason || '无法识别该链接');
      } finally {
        setQuickResolving(false);
      }
      return;
    }

    if (syncRes.needsPlatform && syncRes.roomId) {
      setQuickPendingRoomId(syncRes.roomId);
      setQuickError(syncRes.reason);
      return;
    }
    setQuickPendingRoomId(null);
    setQuickError(syncRes.reason);
  };

  const handleQuickPickPlatform = (platform: PlatformId) => {
    if (!quickPendingRoomId) return;
    const res = parseLiveInput(quickPendingRoomId, platform);
    if (res.ok) {
      setQuickError(null);
      setQuickPendingRoomId(null);
      setQuickInput('');
      onLoadUrlInPane(
        pane.slotIndex,
        res.url,
        `${PLATFORMS[res.platform].shortName} ${res.roomId}`,
        null
      );
    }
  };

  const handleReload = () => {
    if (useDirectStream) {
      autoRetryCountRef.current = 0;
      triedLinesRef.current = new Set();
      setDirectPlayError(null);
      setDirectReloadTick((n) => n + 1);
      return;
    }
    const el = webviewRef.current;
    if (el) {
      try {
        el.reload();
      } catch {
        // Ignore
      }
    }
  };

  const trySwitchFallbackLine = (): boolean => {
    const lines = streamOptions.lines;
    if (!lines || lines.length <= 1) return false;
    const currentId = lines.find((l) => l.active)?.id || directLineId;
    if (currentId) triedLinesRef.current.add(currentId);
    const nextLine = lines.find((l) => !triedLinesRef.current.has(l.id));
    if (!nextLine) return false;
    triedLinesRef.current.add(nextLine.id);
    onUpdatePanePrefs(pane.slotIndex, { preferredLineId: nextLine.id });
    showTempHint(`线路波动，自动切换至 ${nextLine.label}...`);
    return true;
  };

  const handleProbeStreamOptions = async () => {
    if (useDirectStream) {
      setDirectReloadTick((n) => n + 1);
      return;
    }
    const el = webviewRef.current;
    if (!el || !domReady) {
      showTempHint('页面加载中，请稍候再试');
      return;
    }
    setProbing(true);
    try {
      const rect = el.getBoundingClientRect();
      await window.livehub.wakeWebview(el.getWebContentsId(), rect.width, rect.height);
      await new Promise((r) => window.setTimeout(r, 150));
      el.send('livehub:probe-options');
    } catch {
      // Ignore
    }
    window.setTimeout(() => {
      setProbing(false);
      setStreamOptions((cur) => {
        if (cur.qualities.length === 0 && cur.lines.length === 0) {
          showTempHint('未探测到菜单（未开播或请切「网页」调）');
        }
        return cur;
      });
    }, 1100);
  };

  const handleSelectQuality = (labelOrId: string) => {
    if (useDirectStream) {
      triedLinesRef.current = new Set();
      onUpdatePanePrefs(pane.slotIndex, { preferredQualityId: labelOrId });
      setStreamOptions((prev) => ({
        ...prev,
        qualities: prev.qualities.map((q) => ({ ...q, active: q.id === labelOrId })),
      }));
      return;
    }
    const el = webviewRef.current;
    if (!el || !domReady) return;
    const chosen = streamOptions.qualities.find((q) => q.id === labelOrId);
    if (chosen?.locked && !isPlatformLoggedIn && pane.platform) {
      showTempHint('该画质需登录账号后解锁');
      onLoginPlatform(pane.platform);
      return;
    }
    setStreamOptions((prev) => ({
      ...prev,
      qualities: prev.qualities.map((q) => ({ ...q, active: q.id === labelOrId })),
    }));
    try {
      el.send('livehub:select-quality', labelOrId);
    } catch {
      // Ignore
    }
  };

  const handleSelectLine = (labelOrId: string) => {
    if (useDirectStream) {
      triedLinesRef.current = new Set([labelOrId]);
      onUpdatePanePrefs(pane.slotIndex, { preferredLineId: labelOrId });
      setStreamOptions((prev) => ({
        ...prev,
        lines: prev.lines.map((l) => ({ ...l, active: l.id === labelOrId })),
      }));
      return;
    }
    const el = webviewRef.current;
    if (!el || !domReady) return;
    setStreamOptions((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => ({ ...l, active: l.id === labelOrId })),
    }));
    try {
      el.send('livehub:select-line', labelOrId);
    } catch {
      // Ignore
    }
  };

  const activeQualityValue =
    streamOptions.qualities.find((q) => q.active)?.id ??
    streamOptions.qualities[0]?.id ??
    '';
  const activeLineValue =
    streamOptions.lines.find((l) => l.active)?.id ??
    streamOptions.lines[0]?.id ??
    '';

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const fromSlotRaw = e.dataTransfer.getData('application/x-livehub-pane');
    if (fromSlotRaw !== '') {
      const fromSlot = Number(fromSlotRaw);
      if (!Number.isNaN(fromSlot) && fromSlot !== pane.slotIndex) {
        onSwapPanes(fromSlot, pane.slotIndex);
      }
      return;
    }

    const channelRaw = e.dataTransfer.getData('application/x-livehub-channel');
    if (channelRaw) {
      try {
        const ch = JSON.parse(channelRaw) as Channel;
        onLoadChannelInPane(pane.slotIndex, ch);
      } catch {
        // Ignore invalid payload
      }
    }
  };

  return (
    <div
      className={`pane-wrapper ${isActive ? 'active-pane' : ''} ${!pane.url ? 'empty' : ''} ${
        dragOver ? 'drag-over' : ''
      } ${isMaximized ? 'is-maximized' : ''} ${isHiddenByMaximize ? 'is-hidden-by-max' : ''}`}
      onMouseDown={() => onSelectPane(pane.slotIndex)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className={`pane-toolbar ${isSolo || isMaximized ? 'pinned-bar' : ''}`}>
        <div className="pane-toolbar-left">
          <div
            className="pane-drag-handle"
            draggable={!isMaximized}
            onDragStart={(e) => {
              if (isMaximized) return;
              e.dataTransfer.setData('application/x-livehub-pane', String(pane.slotIndex));
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDoubleClick={(e) => {
              if (!canMaximize) return;
              e.stopPropagation();
              onToggleMaximize(pane.slotIndex);
            }}
            title={
              canMaximize
                ? '拖拽互换位置，双击标题栏临时放大/还原分屏'
                : '拖拽与其他分屏互换位置'
            }
          >
            <GripVertical size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            {platformMeta && (
              <span
                className="platform-badge"
                style={{ color: platformMeta.color, background: platformMeta.bgTint }}
              >
                {platformMeta.shortName}
              </span>
            )}
            <span className="pane-title">
              {pane.url ? pane.title : `画面 ${pane.slotIndex + 1}（空闲）`}
            </span>
          </div>
        </div>

        <div className="pane-toolbar-right" onClick={(e) => e.stopPropagation()}>
          {channels.length > 0 && (
            <select
              className="pane-btn"
              style={{ maxWidth: 112 }}
              value={pane.channelId ?? ''}
              onChange={(e) => {
                const chosen = channels.find((c) => c.id === e.target.value);
                if (chosen) onLoadChannelInPane(pane.slotIndex, chosen);
              }}
              title="快速切换收藏主播"
            >
              <option value="" disabled>
                切换主播
              </option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  [{PLATFORMS[ch.platform].shortName}] {ch.name}
                </option>
              ))}
            </select>
          )}

          {pane.url && (
            <>
              {pane.platform && !isPlatformLoggedIn && (
                <button
                  className="pane-btn login-hint"
                  onClick={() => onLoginPlatform(pane.platform!)}
                  title={`当前未登录${platformMeta?.name || ''}，点击扫码登录解锁蓝光/原画高画质`}
                >
                  <KeyRound size={12} />
                  <span>登录解锁蓝光</span>
                </button>
              )}

              {streamOptions.qualities.length > 0 ? (
                <select
                  className="pane-btn pane-select"
                  value={activeQualityValue}
                  onChange={(e) => handleSelectQuality(e.target.value)}
                  title="切换直播画质（原画 / 蓝光 / 超清 / 高清）"
                >
                  {streamOptions.qualities.map((q) => (
                    <option key={q.id} value={q.id}>
                      画质: {q.label}{q.locked ? ' (需登录)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  className="pane-btn"
                  onClick={() => void handleProbeStreamOptions()}
                  title="探测当前播放器画质与线路选项"
                >
                  <SlidersHorizontal size={12} />
                  <span>{probing ? '探测中...' : '画质/线路'}</span>
                </button>
              )}

              {streamOptions.lines.length > 0 && (
                <select
                  className="pane-btn pane-select"
                  value={activeLineValue}
                  onChange={(e) => handleSelectLine(e.target.value)}
                  title="切换 CDN 播放线路"
                >
                  {streamOptions.lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      线路: {l.label}
                    </option>
                  ))}
                </select>
              )}

              {(streamOptions.qualities.length > 0 || streamOptions.lines.length > 0) && (
                <button
                  className="pane-btn"
                  onClick={() => void handleProbeStreamOptions()}
                  title="重新探测画质与线路"
                >
                  <SlidersHorizontal size={12} />
                </button>
              )}

              {paneHint && (
                <span className="pane-btn login-hint" style={{ pointerEvents: 'none' }}>
                  {paneHint}
                </span>
              )}

              <button
                className={`pane-btn ${isSolo ? 'solo-active' : ''}`}
                onClick={() => onToggleSolo(pane.slotIndex)}
                title={isSolo ? '取消独听' : `独听（快捷键 ${pane.slotIndex + 1}）`}
              >
                <Headphones size={12} />
                <span>{isSolo ? '独听中' : '独听'}</span>
              </button>

              <button
                className={`pane-btn ${effectiveMuted ? 'muted-active' : ''}`}
                onClick={() => onToggleMute(pane.slotIndex)}
                title={effectiveMuted ? '取消静音 (M)' : '静音此画面 (M)'}
              >
                {effectiveMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>

              {useDirectStream && directStats && (
                <span
                  className="pane-btn direct-badge"
                  title={
                    directStats.resolution
                      ? `极速直连 ${directStats.protocol} · 分辨率 ${directStats.resolution}`
                      : `极速直连 ${directStats.protocol}`
                  }
                >
                  <Zap size={11} />
                  <span>
                    {directStats.protocol}
                    {directStats.latencySec !== null ? ` ${directStats.latencySec}s` : ''}
                  </span>
                </span>
              )}

              <button
                className={`pane-btn ${pane.mode === 'full' ? 'mode-full' : ''}`}
                onClick={() =>
                  onToggleMode(pane.slotIndex, pane.mode === 'pure' ? 'full' : 'pure')
                }
                title="切换极速直连（超低延迟无广告） / 完整网页模式（发弹幕、看重播）"
              >
                {pane.mode === 'pure' ? <Zap size={12} /> : <Globe size={12} />}
                <span>{pane.mode === 'pure' ? '直连' : '网页'}</span>
              </button>

              {canMaximize && (
                <button
                  className={`pane-btn ${isMaximized ? 'solo-active' : ''}`}
                  onClick={() => onToggleMaximize(pane.slotIndex)}
                  title={isMaximized ? '还原分屏布局 (Esc)' : '临时单屏放大（不破坏当前分屏布局）'}
                >
                  {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
              )}

              {pane.slotIndex > 0 && !isMaximized && (
                <button
                  className="pane-btn"
                  onClick={() => onSwapPanes(pane.slotIndex, 0)}
                  title="切为主屏（与 1 号主画面互换）"
                >
                  <ArrowUpLeft size={12} />
                </button>
              )}

              <button className="pane-btn" onClick={handleReload} title="刷新该直播间 (R)">
                <RefreshCw size={12} />
              </button>

              <button
                className="pane-btn"
                onClick={() => onClearPane(pane.slotIndex)}
                title="关闭此画面"
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {pane.url && useDirectStream ? (
        <div className="direct-stage">
          {directStream?.ok && !directPlayError ? (
            <DirectPlayer
              flvUrl={directStream.flvUrl}
              hlsUrl={directStream.hlsUrl}
              muted={effectiveMuted}
              volume={paneVolume}
              fitMode={paneFitMode}
              reloadToken={directReloadTick}
              danmakuEnabled={localDanmakuOn}
              danmakuArea={danmakuArea}
              danmakuOpacity={danmakuOpacity}
              danmakuFontSize={danmakuFontSize}
              danmakuSpeed={danmakuSpeed}
              danmakuMode={danmakuMode}
              danmakuBlockKeywords={danmakuBlockKeywords}
              danmakuBatch={danmakuBatch}
              danmakuStatus={danmakuStatus}
              onReconnectDanmaku={() => {
                if (parsedTarget && typeof window.livehub?.startDanmaku === 'function') {
                  void window.livehub.startDanmaku(
                    pane.slotIndex,
                    parsedTarget.platform,
                    parsedTarget.roomId,
                    true
                  );
                }
              }}
              onChangeVolume={(vol) => onUpdatePanePrefs(pane.slotIndex, { volume: vol })}
              onToggleFitMode={() =>
                onUpdatePanePrefs(pane.slotIndex, {
                  fitMode: paneFitMode === 'contain' ? 'cover' : 'contain',
                })
              }
              onToggleDanmaku={() =>
                onUpdatePanePrefs(pane.slotIndex, { danmakuEnabled: !localDanmakuOn })
              }
              onChangeDanmakuArea={onChangeDanmakuArea}
              onChangeDanmakuOpacity={onChangeDanmakuOpacity}
              onChangeDanmakuFontSize={onChangeDanmakuFontSize}
              onChangeDanmakuSpeed={onChangeDanmakuSpeed}
              onChangeDanmakuMode={onChangeDanmakuMode}
              onChangeDanmakuBlockKeywords={onChangeDanmakuBlockKeywords}
              onToggleMute={() => onToggleMute(pane.slotIndex)}
              onReload={handleReload}
              onAutoReconnect={() => {
                if (retryTimerRef.current !== null) return;
                if (autoRetryCountRef.current >= 2 && trySwitchFallbackLine()) {
                  autoRetryCountRef.current = 0;
                  setDirectPlayError(null);
                  return;
                }
                if (autoRetryCountRef.current >= 4) {
                  setDirectPlayError('直播流长时间无响应，请点击重试或切换线路');
                  setIsLoading(false);
                  return;
                }
                autoRetryCountRef.current += 1;
                const delayMs = Math.min(5000, autoRetryCountRef.current * 900);
                showTempHint('流连接刷新中，自动续播...');
                retryTimerRef.current = window.setTimeout(() => {
                  retryTimerRef.current = null;
                  setDirectPlayError(null);
                  setDirectReloadTick((n) => n + 1);
                }, delayMs);
              }}
              onPlaying={() => {
                setIsLoading(false);
                autoRetryCountRef.current = 0;
              }}
              onStats={setDirectStats}
              onError={(reason) => {
                if (autoRetryCountRef.current >= 1 && trySwitchFallbackLine()) {
                  autoRetryCountRef.current = 0;
                  setDirectPlayError(null);
                  return;
                }
                if (autoRetryCountRef.current < 3) {
                  autoRetryCountRef.current += 1;
                  const delayMs = autoRetryCountRef.current * 1000;
                  showTempHint('线路波动，自动重连中...');
                  if (retryTimerRef.current !== null) {
                    window.clearTimeout(retryTimerRef.current);
                  }
                  retryTimerRef.current = window.setTimeout(() => {
                    retryTimerRef.current = null;
                    setDirectReloadTick((n) => n + 1);
                  }, delayMs);
                  return;
                }
                setDirectPlayError(reason);
                setIsLoading(false);
              }}
            />
          ) : (
            !isLoading && (
              <div className="direct-status-wrap">
                <div className="direct-status-card">
                  <div className="pane-empty-title">
                    {directStream?.status === 'offline'
                      ? '主播暂未开播'
                      : '直连拉流暂未成功'}
                  </div>
                  <div className="pane-empty-sub">
                    {directPlayError || directStream?.error || '未能解析到实时流地址'}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button className="primary-btn" onClick={handleReload}>
                      <RefreshCw size={12} />
                      <span>重试直连</span>
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => onToggleMode(pane.slotIndex, 'full')}
                    >
                      <Globe size={12} />
                      <span>切网页模式</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          )}
          {isLoading && (
            <div className="pane-loading-overlay">
              <div className="pane-loading-pill">
                <span className="pane-spinner" />
                <span>极速直连拉流中...</span>
              </div>
            </div>
          )}
        </div>
      ) : pane.url && webviewPreloadPath ? (
        <>
          {mountReady && (
            <webview
              key={`${pane.slotIndex}-${pane.url}`}
              ref={(node) => {
                webviewRef.current = node as WebviewElement | null;
              }}
              className="pane-webview"
              src={pane.url}
              partition="persist:livehub"
              preload={webviewPreloadPath}
              allowpopups={true}
            />
          )}
          {(isLoading || !mountReady) && (
            <div className="pane-loading-overlay">
              <div className="pane-loading-pill">
                <span className="pane-spinner" />
                <span>正在加载 {platformMeta?.shortName || ''} 直播间...</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="pane-empty">
          <div className="pane-empty-card">
            <div className="pane-empty-title">画面 {pane.slotIndex + 1}</div>
            <div className="pane-empty-sub">
              从左侧点击或拖拽主播到此窗格，或直接粘贴虎牙 / 斗鱼 / B站 / 抖音链接与口令
            </div>
            <form className="pane-quick-form" onSubmit={(e) => void handleQuickSubmit(e)}>
              <input
                className="text-input"
                value={quickInput}
                onChange={(e) => {
                  setQuickInput(e.target.value);
                  setQuickPendingRoomId(null);
                  setQuickError(null);
                }}
                placeholder="粘贴直播间链接 / 抖音分享口令 / hy:660000"
              />
              <button type="submit" className="primary-btn" disabled={quickResolving}>
                {quickResolving ? '解析中' : '看播'}
              </button>
            </form>
            {quickPendingRoomId && (
              <div className="platform-picker">
                {PLATFORM_LIST.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="platform-chip"
                    style={{ color: p.color, background: p.bgTint, borderColor: p.color }}
                    onClick={() => handleQuickPickPlatform(p.id)}
                  >
                    {p.shortName}
                  </button>
                ))}
              </div>
            )}
            {quickError && <div className="form-hint">{quickError}</div>}
            {channels.length > 0 && (
              <div className="pane-quick-chips">
                {channels.slice(0, 6).map((ch) => {
                  const meta = PLATFORMS[ch.platform];
                  return (
                    <button
                      key={ch.id}
                      className="quick-channel-chip"
                      onClick={() => onLoadChannelInPane(pane.slotIndex, ch)}
                    >
                      <span style={{ color: meta.color, fontWeight: 600 }}>{meta.shortName}</span>
                      <span>{ch.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
