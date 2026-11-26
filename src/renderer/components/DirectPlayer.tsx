import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Globe,
  KeyRound,
  Maximize2,
  MessageSquare,
  MessageSquareOff,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Scan,
  Send,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type {
  DanmakuArea,
  DanmakuMode,
  DanmakuStatusEvent,
  PlatformId,
  SendDanmakuResult,
  VideoFitMode,
} from '../../shared/types';
import { DanmakuOverlay } from './DanmakuOverlay';
import { DanmakuSettingsPopover } from './DanmakuSettingsPopover';

interface DirectPlayerProps {
  slotIndex: number;
  platform?: PlatformId;
  roomId?: string;
  isPlatformLoggedIn?: boolean;
  streamKey?: string;
  flvUrl?: string;
  hlsUrl?: string;
  muted: boolean;
  volume?: number;
  fitMode?: VideoFitMode;
  isObscured?: boolean;
  suspended?: boolean;
  reloadToken: number;
  danmakuEnabled?: boolean;
  danmakuArea?: DanmakuArea;
  danmakuOpacity?: number;
  danmakuFontSize?: number;
  danmakuSpeed?: number;
  danmakuMode?: DanmakuMode;
  danmakuBlockKeywords?: string[];
  danmakuStatus?: DanmakuStatusEvent | null;
  onLoginPlatform?: (platform: PlatformId) => void;
  onSwitchToWebMode?: () => void;
  onReconnectDanmaku?: () => void;
  onChangeVolume?: (volume: number) => void;
  onToggleFitMode?: () => void;
  onToggleDanmaku?: () => void;
  onChangeDanmakuArea?: (area: DanmakuArea) => void;
  onChangeDanmakuOpacity?: (opacity: number) => void;
  onChangeDanmakuFontSize?: (size: number) => void;
  onChangeDanmakuSpeed?: (speed: number) => void;
  onChangeDanmakuMode?: (mode: DanmakuMode) => void;
  onChangeDanmakuBlockKeywords?: (keywords: string[]) => void;
  onToggleMute: () => void;
  onReload: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onAutoReconnect?: (reason?: string) => void;
  onPlaying?: () => void;
  onStats?: (stats: { protocol: 'FLV' | 'HLS'; latencySec: number | null; resolution?: string }) => void;
  onError?: (reason: string) => void;
}

export function DirectPlayer({
  slotIndex,
  platform,
  roomId,
  isPlatformLoggedIn = false,
  streamKey = '',
  flvUrl,
  hlsUrl,
  muted,
  volume: controlledVolume = 1,
  fitMode = 'contain',
  isObscured = false,
  suspended = false,
  reloadToken,
  danmakuEnabled = true,
  danmakuArea = 'half',
  danmakuOpacity = 0.85,
  danmakuFontSize = 18,
  danmakuSpeed = 1,
  danmakuMode = 'scroll',
  danmakuBlockKeywords = [],
  danmakuStatus = null,
  onLoginPlatform,
  onSwitchToWebMode,
  onReconnectDanmaku,
  onChangeVolume,
  onToggleFitMode,
  onToggleDanmaku,
  onChangeDanmakuArea,
  onChangeDanmakuOpacity,
  onChangeDanmakuFontSize,
  onChangeDanmakuSpeed,
  onChangeDanmakuMode,
  onChangeDanmakuBlockKeywords,
  onToggleMute,
  onReload,
  isFullscreen: controlledFullscreen,
  onToggleFullscreen,
  onAutoReconnect,
  onPlaying,
  onStats,
  onError,
}: DirectPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const controlsHoveredRef = useRef(false);
  const [useHlsFallback, setUseHlsFallback] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseSuspended, setPauseSuspended] = useState(false);
  const pauseSuspendedRef = useRef(false);
  pauseSuspendedRef.current = pauseSuspended;
  const pauseSuspendTimerRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const isObscuredRef = useRef(isObscured);
  isObscuredRef.current = isObscured;
  const [localFullscreen, setLocalFullscreen] = useState(false);
  const isFullscreen = onToggleFullscreen ? Boolean(controlledFullscreen) : localFullscreen;
  const [controlsIdle, setControlsIdle] = useState(false);
  const [liveBadge, setLiveBadge] = useState<string>('FLV');
  const [videoReady, setVideoReady] = useState(false);
  const [dmPanelOpen, setDmPanelOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [composerSending, setComposerSending] = useState(false);
  const [composerCooldown, setComposerCooldown] = useState(false);
  const [hudToast, setHudToast] = useState<string | null>(null);
  const dmPanelRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const cooldownTimerRef = useRef<number | null>(null);

  const volume = Math.max(0, Math.min(1, Number.isFinite(controlledVolume) ? controlledVolume : 1));
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  const userPausedRef = useRef(false);
  const onPlayingRef = useRef(onPlaying);
  const onStatsRef = useRef(onStats);
  const onErrorRef = useRef(onError);
  const onAutoReconnectRef = useRef(onAutoReconnect);
  mutedRef.current = muted;
  volumeRef.current = volume;
  onPlayingRef.current = onPlaying;
  onStatsRef.current = onStats;
  onErrorRef.current = onError;
  onAutoReconnectRef.current = onAutoReconnect;

  const showHud = useCallback((msg: string) => {
    setHudToast(msg);
    if (hudTimerRef.current !== null) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      hudTimerRef.current = null;
      setHudToast(null);
    }, 1500);
  }, []);

  const scheduleIdleHide = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (!isFullscreen) {
      setControlsIdle(false);
      return;
    }
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (!controlsHoveredRef.current) {
        setControlsIdle(true);
      }
    }, 2200);
  }, [isFullscreen]);

  const wakeControls = useCallback(() => {
    setControlsIdle(false);
    scheduleIdleHide();
  }, [scheduleIdleHide]);

  useEffect(() => {
    if (!isFullscreen) {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      controlsHoveredRef.current = false;
      setControlsIdle(false);
      return;
    }
    controlsHoveredRef.current = false;
    if (isPaused || dmPanelOpen || composerOpen) {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setControlsIdle(false);
      return;
    }
    scheduleIdleHide();
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isFullscreen, isPaused, dmPanelOpen, composerOpen, scheduleIdleHide]);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
      if (hudTimerRef.current !== null) {
        window.clearTimeout(hudTimerRef.current);
      }
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      if (pauseSuspendTimerRef.current !== null) {
        window.clearTimeout(pauseSuspendTimerRef.current);
      }
      if (cooldownTimerRef.current !== null) {
        window.clearTimeout(cooldownTimerRef.current);
      }
    };
  }, []);

  const handleSendDanmaku = useCallback(
    async (rawText: string): Promise<SendDanmakuResult> => {
      const clean = rawText.replace(/\s+/g, ' ').trim();
      if (!clean) {
        return { ok: false, error: '请输入弹幕内容' };
      }
      if (!platform || !roomId || typeof window.livehub?.sendDanmaku !== 'function') {
        return { ok: false, error: '当前直播间暂无法发送弹幕' };
      }
      const res = await window.livehub.sendDanmaku(platform, roomId, clean);
      if (res.ok) {
        showHud('弹幕已发送');
      } else if (res.error) {
        showHud(res.error);
      }
      return res;
    },
    [platform, roomId, showHud]
  );

  const submitFloatingComposer = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (composerSending || composerCooldown) return;
      const clean = composerText.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      setComposerSending(true);
      try {
        const res = await handleSendDanmaku(clean);
        if (res.ok) {
          setComposerText('');
          setComposerCooldown(true);
          if (cooldownTimerRef.current !== null) {
            window.clearTimeout(cooldownTimerRef.current);
          }
          cooldownTimerRef.current = window.setTimeout(() => {
            cooldownTimerRef.current = null;
            setComposerCooldown(false);
          }, 1500);
        }
      } finally {
        setComposerSending(false);
        window.setTimeout(() => composerInputRef.current?.focus(), 0);
      }
    },
    [composerSending, composerCooldown, composerText, handleSendDanmaku]
  );

  useEffect(() => {
    setComposerText('');
  }, [streamKey]);

  useEffect(() => {
    if (!composerOpen) return;
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
    const onDown = (e: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement | null;
        if (!target?.closest('[data-dm-composer-toggle="1"]')) {
          setComposerOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [composerOpen]);

  const handleScreenshot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      showHud('画面尚未就绪，暂无法截图');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      if (typeof window.livehub?.copyScreenshot === 'function') {
        const ok = await window.livehub.copyScreenshot(dataUrl);
        showHud(ok ? '已复制截图到剪贴板' : '截图复制失败');
      }
    } catch {
      showHud('截图失败');
    }
  }, [showHud]);

  const applyVolumeDelta = useCallback(
    (delta: number) => {
      const base = mutedRef.current ? 0 : volumeRef.current;
      const next = Math.max(0, Math.min(1, Math.round((base + delta) * 20) / 20));
      onChangeVolume?.(next);
      if (next > 0 && mutedRef.current) {
        onToggleMute();
      } else if (next === 0 && !mutedRef.current) {
        onToggleMute();
      }
      showHud(next === 0 ? '已静音' : `音量 ${Math.round(next * 100)}%`);
    },
    [onChangeVolume, onToggleMute, showHud]
  );

  useEffect(() => {
    userPausedRef.current = false;
    pausedAtRef.current = null;
    if (pauseSuspendTimerRef.current !== null) {
      window.clearTimeout(pauseSuspendTimerRef.current);
      pauseSuspendTimerRef.current = null;
    }
    setPauseSuspended(false);
    setUseHlsFallback(false);
    setIsPaused(false);
    setVideoReady(false);
    if (videoRef.current) {
      videoRef.current.removeAttribute('poster');
    }
  }, [flvUrl, hlsUrl, reloadToken]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = muted;
      video.volume = volume;
    }
  }, [muted, volume]);

  useEffect(() => {
    if (onToggleFullscreen) return;
    const handleFsChange = () => {
      const container = containerRef.current;
      const video = videoRef.current;
      const fsEl = document.fullscreenElement;
      setLocalFullscreen(Boolean(fsEl && (fsEl === container || fsEl === video)));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, [onToggleFullscreen]);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || userPausedRef.current) {
      if (pauseSuspendTimerRef.current !== null) {
        window.clearTimeout(pauseSuspendTimerRef.current);
        pauseSuspendTimerRef.current = null;
      }
      const wasSuspended = pauseSuspendedRef.current;
      const pausedMs = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
      userPausedRef.current = false;
      pausedAtRef.current = null;
      setIsPaused(false);
      if (wasSuspended) {
        setPauseSuspended(false);
        if (pausedMs > 60_000) {
          onAutoReconnectRef.current?.('resume-from-pause');
        }
        return;
      }
      // Jump to live edge on resume so latency does not accumulate while paused
      if (video.buffered && video.buffered.length > 0) {
        try {
          const lastIdx = video.buffered.length - 1;
          const lastStart = video.buffered.start(lastIdx);
          const lastEnd = video.buffered.end(lastIdx);
          const span = lastEnd - lastStart;
          if (Number.isFinite(lastEnd) && span >= 0.8 && lastEnd - video.currentTime > 2.5) {
            const desired = lastEnd - Math.min(1.2, span * 0.45);
            const target = Math.max(lastStart + 0.15, Math.min(lastEnd - 0.25, desired));
            if (target > video.currentTime + 0.5) {
              video.currentTime = target;
            }
          }
        } catch {
          // Ignore seek errors
        }
      }
      video.playbackRate = 1;
      video.muted = mutedRef.current;
      video.volume = volumeRef.current;
      void video.play().catch(() => {});
    } else {
      userPausedRef.current = true;
      pausedAtRef.current = Date.now();
      video.playbackRate = 1;
      video.pause();
      setIsPaused(true);
      // After 10s paused, capture current frame as poster and unload live stream so it stops
      // downloading full bitrate in background while keeping the exact paused frame visible
      if (pauseSuspendTimerRef.current !== null) {
        window.clearTimeout(pauseSuspendTimerRef.current);
      }
      pauseSuspendTimerRef.current = window.setTimeout(() => {
        pauseSuspendTimerRef.current = null;
        if (!userPausedRef.current) return;
        const v = videoRef.current;
        if (v && v.videoWidth > 0 && v.videoHeight > 0) {
          try {
            const snap = document.createElement('canvas');
            snap.width = v.videoWidth;
            snap.height = v.videoHeight;
            const sctx = snap.getContext('2d');
            if (sctx) {
              sctx.drawImage(v, 0, 0, snap.width, snap.height);
              v.poster = snap.toDataURL('image/jpeg', 0.85);
            }
          } catch {
            // Ignore frame capture errors
          }
        }
        setPauseSuspended(true);
      }, 10_000);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (onToggleFullscreen) {
      onToggleFullscreen();
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void container.requestFullscreen().catch(() => {
        // Fallback to video element fullscreen if container fails
        void videoRef.current?.requestFullscreen().catch(() => {});
      });
    }
  }, [onToggleFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (suspended || pauseSuspended) {
      return;
    }

    const shouldUseFlv = Boolean(flvUrl) && !useHlsFallback && mpegts.isSupported();
    const activeProtocol: 'FLV' | 'HLS' = shouldUseFlv ? 'FLV' : 'HLS';
    const targetUrl = shouldUseFlv ? flvUrl : hlsUrl;

    if (!targetUrl) {
      onErrorRef.current?.('当前清晰度暂无可用直连流地址');
      return;
    }

    let disposed = false;
    let flvPlayer: mpegts.Player | null = null;
    let hlsPlayer: Hls | null = null;
    let recoverTries = 0;
    let reconnectTriggered = false;
    let autoResumeTimer: number | null = null;
    let lastObservedTime = -1;
    let stalledTicks = 0;
    let startupTicks = 0;
    let healthyTicks = 0;

    video.muted = mutedRef.current;
    video.volume = volumeRef.current;
    setLiveBadge(activeProtocol);

    const triggerSeamlessReconnect = (reason: string) => {
      if (disposed || reconnectTriggered || userPausedRef.current) return;
      reconnectTriggered = true;
      if (onAutoReconnectRef.current) {
        onAutoReconnectRef.current(reason);
      } else {
        onErrorRef.current?.(`直播流连接已断开（${reason}），正在重连`);
      }
    };

    const jumpToLiveEdgeAndPlay = (v: HTMLVideoElement) => {
      if (v.buffered && v.buffered.length > 0) {
        try {
          const firstStart = v.buffered.start(0);
          const lastIdx = v.buffered.length - 1;
          const lastStart = v.buffered.start(lastIdx);
          const lastEnd = v.buffered.end(lastIdx);
          const span = lastEnd - lastStart;
          // CRITICAL: target must be strictly inside the last buffered range [lastStart, lastEnd).
          // Seeking into an unbuffered gap between two ranges causes mpegts.js SeekingHandler to flush
          // the entire MSE SourceBuffer and abort the live stream!
          if (Number.isFinite(lastEnd) && span >= 0.8) {
            const desired = lastEnd - Math.min(1.2, span * 0.45);
            const target = Math.max(lastStart + 0.15, Math.min(lastEnd - 0.25, desired));
            const fellBehindBuffer = v.currentTime < firstStart - 0.05;
            const stuckBeforeGap = v.buffered.length > 1 && v.currentTime < lastStart - 0.05;
            if ((fellBehindBuffer || stuckBeforeGap || target > v.currentTime + 1.5) && target > v.currentTime) {
              v.currentTime = target;
            }
          }
        } catch {
          // Ignore seek errors
        }
      }
      v.playbackRate = 1;
      v.muted = mutedRef.current;
      v.volume = volumeRef.current;
      void v.play().catch(() => {});
    };

    const handlePlaying = () => {
      if (!disposed) {
        stalledTicks = 0;
        if (!userPausedRef.current) {
          setIsPaused(false);
        }
        if (video.poster) {
          video.removeAttribute('poster');
        }
        setVideoReady(true);
        video.muted = mutedRef.current;
        video.volume = volumeRef.current;
        onPlayingRef.current?.();
      }
    };
    const handlePause = () => {
      if (disposed) return;
      if (userPausedRef.current) {
        setIsPaused(true);
        return;
      }
      // System/browser/MSE unexpected auto-pause (e.g. audio device change, window occlusion, buffer underrun):
      // Do NOT leave the live stream stuck paused — attempt immediate auto-resume!
      if (autoResumeTimer !== null) window.clearTimeout(autoResumeTimer);
      autoResumeTimer = window.setTimeout(() => {
        autoResumeTimer = null;
        if (disposed || userPausedRef.current || !videoRef.current) return;
        const v = videoRef.current;
        if (v.paused) {
          if (v.buffered && v.buffered.length > 0 && v.currentTime < v.buffered.start(0) - 0.05) {
            jumpToLiveEdgeAndPlay(v);
          } else {
            v.muted = mutedRef.current;
            v.volume = volumeRef.current;
            void v.play().catch(() => {});
          }
        }
      }, 280);
    };
    const handleEnded = () => {
      if (!disposed && !userPausedRef.current) {
        triggerSeamlessReconnect(healthyTicks < 4 ? 'early-eof' : 'video-ended');
      }
    };
    const handleVisibility = () => {
      if (
        !disposed &&
        !document.hidden &&
        !userPausedRef.current &&
        videoRef.current &&
        videoRef.current.paused
      ) {
        jumpToLiveEdgeAndPlay(videoRef.current);
      }
    };
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('loadeddata', handlePlaying);
    video.addEventListener('canplay', handlePlaying);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    document.addEventListener('visibilitychange', handleVisibility);

    if (shouldUseFlv) {
      try {
        flvPlayer = mpegts.createPlayer(
          {
            type: 'flv',
            isLive: true,
            url: targetUrl,
            cors: true,
          },
          {
            enableWorker: false,
            enableStashBuffer: true,
            stashInitialSize: 128 * 1024,
            // Critical for continuous live FLV: prevent mpegts.js LoadingController from pausing/aborting HTTP stream
            lazyLoad: false,
            // Disable aggressive hard-seek latency chasing so a stable stream never jumps/skips frames
            liveBufferLatencyChasing: false,
            autoCleanupSourceBuffer: true,
            // Keep 25-45s backward buffer: safely larger than 10-16s GOPs while halving MSE RAM usage
            autoCleanupMaxBackwardDuration: 45,
            autoCleanupMinBackwardDuration: 25,
          }
        );

        flvPlayer.attachMediaElement(video);
        flvPlayer.load();
        const playPromise = flvPlayer.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err: unknown) => {
            // Only fall back to muted autoplay on genuine NotAllowedError; never mute on AbortError
            const name = err instanceof Error ? err.name : '';
            if (!disposed && videoRef.current && name === 'NotAllowedError') {
              videoRef.current.muted = true;
              void videoRef.current.play().catch(() => {});
            }
          });
        }

        // Critical for long playback: CDNs periodically close chunked HTTP-FLV connections (EOF)
        // which fires LOADING_COMPLETE rather than ERROR — reconnect seamlessly with a fresh URL!
        // If EOF fires before ~6s of healthy playback, mark as 'early-eof' so LivePane switches CDN line immediately.
        flvPlayer.on(mpegts.Events.LOADING_COMPLETE, () => {
          if (!disposed && !userPausedRef.current) {
            triggerSeamlessReconnect(healthyTicks < 4 ? 'early-eof' : 'flv-eof');
          }
        });

        flvPlayer.on(mpegts.Events.ERROR, (errType: string, errDetail: string) => {
          if (disposed) return;
          if (hlsUrl && !useHlsFallback) {
            setUseHlsFallback(true);
            return;
          }
          onErrorRef.current?.(`FLV 播放中断 (${errType}: ${errDetail})`);
        });
      } catch (e) {
        if (hlsUrl && !useHlsFallback) {
          setUseHlsFallback(true);
        } else {
          onErrorRef.current?.(e instanceof Error ? e.message : 'FLV 播放器初始化失败');
        }
      }
    } else if (Hls.isSupported()) {
      hlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxLiveSyncPlaybackRate: 1.08,
        backBufferLength: 15,
      });
      hlsPlayer.loadSource(targetUrl);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        if (disposed) return;
        video.muted = mutedRef.current;
        video.volume = volumeRef.current;
        void video.play().catch(() => {});
      });
      hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || !data.fatal) return;
        if (recoverTries < 4) {
          recoverTries += 1;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hlsPlayer?.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hlsPlayer?.recoverMediaError();
            return;
          }
        }
        onErrorRef.current?.(`HLS 播放中断 (${data.details || data.type})`);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = targetUrl;
      void video.play().catch(() => {});
    } else {
      onErrorRef.current?.('当前环境不支持直连 MSE 解码');
    }

    const statsTimer = window.setInterval(() => {
      if (disposed || !videoRef.current) return;
      const v = videoRef.current;
      let latencySec: number | null = null;
      let hasBuffer = false;
      let bufEnd = 0;

      if (v.buffered && v.buffered.length > 0) {
        hasBuffer = true;
        const firstStart = v.buffered.start(0);
        const lastIdx = v.buffered.length - 1;
        const lastStart = v.buffered.start(lastIdx);
        bufEnd = v.buffered.end(lastIdx);
        const drift = bufEnd - v.currentTime;

        // Rescue only if currentTime fell behind cleaned SourceBuffer range (buffer gap stall)
        if (!userPausedRef.current && v.currentTime < firstStart - 0.05) {
          jumpToLiveEdgeAndPlay(v);
        } else if (Number.isFinite(drift) && drift >= 0) {
          latencySec = Math.round(drift * 10) / 10;
          // Stability-first FLV latency control:
          // Never hard-jump a healthy stream; only apply imperceptible playbackRate catch-up if drift grows large,
          // and only hard-seek on extreme backlog (>24s, e.g. system sleep resume) strictly inside the last range.
          if (activeProtocol === 'FLV' && !v.paused && !userPausedRef.current) {
            if (drift > 24 && bufEnd - lastStart >= 1.2) {
              try {
                v.playbackRate = 1;
                v.currentTime = Math.max(lastStart + 0.2, bufEnd - 1.8);
              } catch {
                // Ignore seek errors
              }
            } else if (stalledTicks === 0 && drift > 12.0) {
              if (v.playbackRate !== 1.08) v.playbackRate = 1.08;
            } else if (stalledTicks === 0 && drift > 8.5) {
              if (v.playbackRate !== 1.04) v.playbackRate = 1.04;
            } else if (drift <= 4.5 || stalledTicks > 0) {
              if (v.playbackRate !== 1) v.playbackRate = 1;
            }
          }
        }
      }

      // Watchdog for long playback: detect unexpected pause or truly frozen frames while user did NOT pause.
      // Never falsely trigger stall reconnect while the window or pane is hidden (minimized / boss-key / maximize-hidden).
      const isPaneHidden = document.hidden || Boolean(isObscuredRef.current) || v.offsetParent === null;
      if (!userPausedRef.current && !isPaneHidden) {
        if (v.paused && hasBuffer && v.readyState >= 2) {
          void v.play().catch(() => {});
        }

        if (v.readyState >= 2 && v.videoWidth > 0) {
          startupTicks = 0;
          if (lastObservedTime >= 0 && Math.abs(v.currentTime - lastObservedTime) < 0.05) {
            stalledTicks += 1;
            healthyTicks = 0;
            if (v.playbackRate !== 1) {
              v.playbackRate = 1;
            }
            // Only jump if there is an actual disjoint buffer gap (v.buffered.length > 1) and a playable range ahead;
            // on a normal single-range network pause, NEVER seek (seeking triggers mpegts flush!) — just wait for packets.
            if (stalledTicks === 4 && hasBuffer && v.buffered.length > 1) {
              jumpToLiveEdgeAndPlay(v);
            } else if (stalledTicks >= 10) {
              // Hard stall (~15s completely frozen): TCP socket stalled or signed URL expired -> reconnect cleanly
              triggerSeamlessReconnect('stall-watchdog');
              return;
            }
          } else {
            stalledTicks = 0;
            healthyTicks += 1;
            // After ~15s of continuous healthy playback, reset transient HLS recover budget
            if (healthyTicks >= 10 && recoverTries > 0) {
              recoverTries = 0;
            }
          }
          lastObservedTime = v.currentTime;
        } else {
          // Stream has not decoded its first frame yet: guard against blackhole CDN nodes that accept TCP but send 0 frames
          startupTicks += 1;
          if (startupTicks >= 5) {
            startupTicks = 0;
            if (shouldUseFlv && hlsUrl && !useHlsFallback) {
              setUseHlsFallback(true);
              return;
            }
            triggerSeamlessReconnect('startup-timeout');
            return;
          }
        }
      } else {
        stalledTicks = 0;
        startupTicks = 0;
        if (userPausedRef.current && v.playbackRate !== 1) {
          v.playbackRate = 1;
        }
      }

      if (v.readyState >= 2 && v.videoWidth > 0) {
        setVideoReady(true);
        if (stalledTicks === 0 && !v.paused) {
          onPlayingRef.current?.();
        }
      }
      if (isPaneHidden) return;

      const resolution =
        v.videoWidth && v.videoHeight ? `${v.videoWidth}×${v.videoHeight}` : undefined;
      const resTag = v.videoHeight ? `${Math.min(v.videoWidth, v.videoHeight)}P` : '';
      const nextBadge = [resTag, activeProtocol, latencySec !== null ? `${latencySec}s` : '']
        .filter(Boolean)
        .join(' · ');
      setLiveBadge((prev) => (prev === nextBadge ? prev : nextBadge));
      onStatsRef.current?.({ protocol: activeProtocol, latencySec, resolution });
    }, 1500);

    return () => {
      disposed = true;
      window.clearInterval(statsTimer);
      if (autoResumeTimer !== null) window.clearTimeout(autoResumeTimer);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('loadeddata', handlePlaying);
      video.removeEventListener('canplay', handlePlaying);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (flvPlayer) {
        try {
          flvPlayer.pause();
          flvPlayer.unload();
          flvPlayer.detachMediaElement();
          flvPlayer.destroy();
        } catch {
          // Ignore teardown errors
        }
      }
      if (hlsPlayer) {
        try {
          hlsPlayer.destroy();
        } catch {
          // Ignore teardown errors
        }
      }
      video.playbackRate = 1;
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // Ignore
      }
    };
  }, [flvUrl, hlsUrl, useHlsFallback, reloadToken, suspended, pauseSuspended]);

  useEffect(() => {
    if (!dmPanelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dmPanelRef.current && !dmPanelRef.current.contains(e.target as Node)) {
        setDmPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [dmPanelOpen]);

  const isIdleHidden = isFullscreen && controlsIdle && !isPaused && !dmPanelOpen && !composerOpen;
  const canDirectSend = platform === 'bilibili';

  return (
    <div
      ref={containerRef}
      className={`direct-player-root ${isPaused ? 'is-paused' : ''} ${isFullscreen ? 'is-fullscreen' : ''} ${
        isIdleHidden ? 'is-idle' : ''
      } ${dmPanelOpen || composerOpen ? 'dm-menu-open' : ''}`}
      tabIndex={0}
      onMouseMove={() => {
        if (isFullscreen) wakeControls();
      }}
      onMouseDown={() => {
        if (isFullscreen) wakeControls();
      }}
      onWheel={(e) => {
        if (isFullscreen) wakeControls();
        const target = e.target as HTMLElement | null;
        if (target?.closest('.dm-style-popover, .danmaku-chat-panel')) return;
        if (Math.abs(e.deltaY) < 4) return;
        e.preventDefault();
        applyVolumeDelta(e.deltaY < 0 ? 0.05 : -0.05);
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (e.key === 'Escape' && composerOpen) {
          e.stopPropagation();
          setComposerOpen(false);
          containerRef.current?.focus();
          return;
        }
        if (e.key === 'Escape' && dmPanelOpen) {
          e.stopPropagation();
          setDmPanelOpen(false);
          return;
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
          return;
        }
        if (e.key === 'Enter' && platform) {
          e.preventDefault();
          e.stopPropagation();
          setComposerOpen(true);
          return;
        }
        if (e.code === 'Space') {
          e.preventDefault();
          togglePlayPause();
        } else if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          toggleFullscreen();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          applyVolumeDelta(0.05);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          applyVolumeDelta(-0.05);
        }
      }}
    >
      <video
        ref={videoRef}
        className={`direct-video ${videoReady ? 'is-ready' : ''} ${fitMode === 'cover' ? 'fit-cover' : ''}`}
        autoPlay
        playsInline
        muted={muted}
        onClick={() => {
          if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
            return;
          }
          clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null;
            togglePlayPause();
          }, 190);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          toggleFullscreen();
        }}
      />

      <DanmakuOverlay
        slotIndex={slotIndex}
        platform={platform}
        isPlatformLoggedIn={isPlatformLoggedIn}
        streamKey={streamKey}
        enabled={danmakuEnabled && !suspended}
        paused={isPaused}
        isObscured={isObscured}
        area={danmakuArea}
        opacity={danmakuOpacity}
        fontSize={danmakuFontSize}
        speed={danmakuSpeed}
        mode={danmakuMode}
        blockKeywords={danmakuBlockKeywords}
        onSendDanmaku={handleSendDanmaku}
        onLoginPlatform={onLoginPlatform}
        onSwitchToWebMode={onSwitchToWebMode}
      />

      {composerOpen && platform && (
        <div
          ref={composerRef}
          className="direct-dm-composer"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          {canDirectSend ? (
            isPlatformLoggedIn ? (
              <form className="direct-dm-composer-form" onSubmit={(e) => void submitFloatingComposer(e)}>
                <input
                  ref={composerInputRef}
                  className="direct-dm-composer-input"
                  value={composerText}
                  maxLength={40}
                  onChange={(e) => setComposerText(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                      setComposerOpen(false);
                      containerRef.current?.focus();
                    }
                  }}
                  placeholder={composerCooldown ? '发送成功，稍候片刻...' : '直连发送 B站弹幕 (Enter)...'}
                  disabled={composerSending}
                />
                <button
                  type="submit"
                  className="direct-dm-composer-send"
                  disabled={composerSending || composerCooldown || !composerText.trim()}
                  title="发送弹幕 (Enter)"
                >
                  <Send size={12} />
                  <span>{composerSending ? '发送中' : '发送'}</span>
                </button>
                <button
                  type="button"
                  className="direct-dm-composer-close"
                  onClick={() => setComposerOpen(false)}
                  title="关闭输入框 (Esc)"
                >
                  <X size={13} />
                </button>
              </form>
            ) : (
              <div className="direct-dm-composer-notice">
                <span>登录 B站后可在直连模式直接发弹幕</span>
                <div className="direct-dm-composer-actions">
                  <button
                    type="button"
                    className="direct-dm-composer-action-btn primary"
                    onClick={() => {
                      setComposerOpen(false);
                      onLoginPlatform?.('bilibili');
                    }}
                  >
                    <KeyRound size={12} />
                    <span>扫码登录 B站</span>
                  </button>
                  <button
                    type="button"
                    className="direct-dm-composer-close"
                    onClick={() => setComposerOpen(false)}
                    title="关闭"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            )
          ) : (
            <div className="direct-dm-composer-notice">
              <span>直连发弹幕暂仅支持 B站，当前平台可切网页发送</span>
              <div className="direct-dm-composer-actions">
                {onSwitchToWebMode && (
                  <button
                    type="button"
                    className="direct-dm-composer-action-btn primary"
                    onClick={() => {
                      setComposerOpen(false);
                      onSwitchToWebMode();
                    }}
                  >
                    <Globe size={12} />
                    <span>切网页发弹幕</span>
                  </button>
                )}
                <button
                  type="button"
                  className="direct-dm-composer-close"
                  onClick={() => setComposerOpen(false)}
                  title="关闭"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {hudToast && <div className="direct-hud-toast">{hudToast}</div>}

      {isPaused && (
        <button
          className="direct-pause-center"
          onClick={togglePlayPause}
          title="继续播放直播"
        >
          <Play size={26} fill="currentColor" style={{ marginLeft: 3 }} />
        </button>
      )}

      <div
        className="direct-controls-bar"
        onMouseEnter={() => {
          controlsHoveredRef.current = true;
          if (idleTimerRef.current !== null) {
            window.clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
          }
          setControlsIdle(false);
        }}
        onMouseLeave={() => {
          controlsHoveredRef.current = false;
          if (isFullscreen) scheduleIdleHide();
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="direct-controls-group">
          <button
            className="direct-ctrl-btn"
            onClick={togglePlayPause}
            title={isPaused ? '继续播放 (Space)' : '暂停画面 (Space)'}
          >
            {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} />}
          </button>

          <button
            className="direct-ctrl-btn"
            onClick={onReload}
            title="刷新直播流 / 追帧 (R)"
          >
            <RefreshCw size={13} />
          </button>

          <div className="direct-volume-box">
            <button
              className="direct-ctrl-btn"
              onClick={onToggleMute}
              title={muted ? '取消静音 (M)' : '静音 (M)'}
            >
              {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input
              type="range"
              className="direct-volume-slider"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              title={`音量 ${Math.round((muted ? 0 : volume) * 100)}%（滚轮也可微调）`}
              onChange={(e) => {
                const next = Number(e.target.value);
                onChangeVolume?.(next);
                if (next > 0 && muted) {
                  onToggleMute();
                } else if (next === 0 && !muted) {
                  onToggleMute();
                }
              }}
            />
          </div>
        </div>

        <div className="direct-controls-group">
          <span className="direct-live-tag">
            <span className="direct-live-dot" />
            {liveBadge}
          </span>

          {danmakuEnabled &&
            danmakuStatus &&
            (danmakuStatus.state === 'reconnecting' || danmakuStatus.state === 'error') && (
              <button
                type="button"
                className="direct-dm-status-pill"
                onClick={() => onReconnectDanmaku?.()}
                title={danmakuStatus.message || '弹幕连接异常，点击立即重连'}
              >
                {danmakuStatus.state === 'reconnecting' ? '弹幕重连中' : '弹幕断开·点此重连'}
              </button>
            )}

          {onToggleFitMode && (
            <button
              className={`direct-ctrl-btn ${fitMode === 'cover' ? 'dm-active' : ''}`}
              onClick={() => {
                onToggleFitMode();
                showHud(fitMode === 'cover' ? '画面：等比完整' : '画面：铺满去黑边');
              }}
              title={fitMode === 'cover' ? '当前：铺满裁切（点击切换等比完整）' : '当前：等比完整（点击铺满去黑边）'}
            >
              <Scan size={13} />
            </button>
          )}

          <button
            className="direct-ctrl-btn"
            onClick={() => void handleScreenshot()}
            title="一键截图并复制到剪贴板"
          >
            <Camera size={13} />
          </button>

          {platform && (
            <button
              type="button"
              data-dm-composer-toggle="1"
              className={`direct-ctrl-btn ${composerOpen ? 'dm-active' : ''}`}
              onClick={() => {
                setDmPanelOpen(false);
                setComposerOpen((v) => !v);
              }}
              title={
                canDirectSend
                  ? isPlatformLoggedIn
                    ? '直连发送 B站弹幕 (Enter)'
                    : '登录 B站后可在直连模式发弹幕'
                  : '发弹幕（当前平台可一键切网页发送）'
              }
            >
              <Send size={13} />
            </button>
          )}

          {onToggleDanmaku && (
            <button
              className={`direct-ctrl-btn ${danmakuEnabled ? 'dm-active' : ''}`}
              onClick={onToggleDanmaku}
              title={danmakuEnabled ? '关闭此画面弹幕' : '开启此画面弹幕'}
            >
              {danmakuEnabled ? <MessageSquare size={14} /> : <MessageSquareOff size={14} />}
            </button>
          )}

          {onChangeDanmakuArea &&
            onChangeDanmakuOpacity &&
            onChangeDanmakuFontSize &&
            onChangeDanmakuSpeed &&
            onChangeDanmakuMode &&
            onChangeDanmakuBlockKeywords && (
              <div className="direct-dm-settings-wrap" ref={dmPanelRef}>
                <button
                  className={`direct-ctrl-btn ${dmPanelOpen ? 'dm-active' : ''}`}
                  onClick={() => setDmPanelOpen((v) => !v)}
                  title="弹幕样式：模式 / 区域 / 透明度 / 字号 / 速度 / 屏蔽词"
                >
                  <SlidersHorizontal size={13} />
                </button>

                {dmPanelOpen && (
                  <DanmakuSettingsPopover
                    variant="player"
                    area={danmakuArea}
                    opacity={danmakuOpacity}
                    fontSize={danmakuFontSize}
                    speed={danmakuSpeed}
                    mode={danmakuMode}
                    blockKeywords={danmakuBlockKeywords}
                    onChangeArea={onChangeDanmakuArea}
                    onChangeOpacity={onChangeDanmakuOpacity}
                    onChangeFontSize={onChangeDanmakuFontSize}
                    onChangeSpeed={onChangeDanmakuSpeed}
                    onChangeMode={onChangeDanmakuMode}
                    onChangeBlockKeywords={onChangeDanmakuBlockKeywords}
                  />
                )}
              </div>
            )}

          <button
            type="button"
            className="direct-ctrl-btn"
            onClick={(e) => {
              e.currentTarget.blur();
              toggleFullscreen();
            }}
            title={isFullscreen ? '退出全屏 (Esc / F)' : '全屏观看 (双击画面 / F)'}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
