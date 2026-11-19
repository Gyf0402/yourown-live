import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Maximize2,
  MessageSquare,
  MessageSquareOff,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Scan,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type {
  DanmakuArea,
  DanmakuMessage,
  DanmakuMode,
  DanmakuStatusEvent,
  VideoFitMode,
} from '../../shared/types';
import { DanmakuOverlay } from './DanmakuOverlay';
import { DanmakuSettingsPopover } from './DanmakuSettingsPopover';

interface DirectPlayerProps {
  flvUrl?: string;
  hlsUrl?: string;
  muted: boolean;
  volume?: number;
  fitMode?: VideoFitMode;
  reloadToken: number;
  danmakuEnabled?: boolean;
  danmakuArea?: DanmakuArea;
  danmakuOpacity?: number;
  danmakuFontSize?: number;
  danmakuSpeed?: number;
  danmakuMode?: DanmakuMode;
  danmakuBlockKeywords?: string[];
  danmakuBatch?: DanmakuMessage[];
  danmakuStatus?: DanmakuStatusEvent | null;
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
  onAutoReconnect?: () => void;
  onPlaying?: () => void;
  onStats?: (stats: { protocol: 'FLV' | 'HLS'; latencySec: number | null; resolution?: string }) => void;
  onError?: (reason: string) => void;
}

export function DirectPlayer({
  flvUrl,
  hlsUrl,
  muted,
  volume: controlledVolume = 1,
  fitMode = 'contain',
  reloadToken,
  danmakuEnabled = true,
  danmakuArea = 'half',
  danmakuOpacity = 0.85,
  danmakuFontSize = 18,
  danmakuSpeed = 1,
  danmakuMode = 'scroll',
  danmakuBlockKeywords = [],
  danmakuBatch = [],
  danmakuStatus = null,
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
  onAutoReconnect,
  onPlaying,
  onStats,
  onError,
}: DirectPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const [useHlsFallback, setUseHlsFallback] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [liveBadge, setLiveBadge] = useState<string>('FLV');
  const [videoReady, setVideoReady] = useState(false);
  const [dmPanelOpen, setDmPanelOpen] = useState(false);
  const [hudToast, setHudToast] = useState<string | null>(null);
  const dmPanelRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
      if (hudTimerRef.current !== null) {
        window.clearTimeout(hudTimerRef.current);
      }
    };
  }, []);

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
    setUseHlsFallback(false);
    setIsPaused(false);
    setVideoReady(false);
  }, [flvUrl, hlsUrl, reloadToken]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = muted;
      video.volume = volume;
    }
  }, [muted, volume]);

  useEffect(() => {
    const handleFsChange = () => {
      const container = containerRef.current;
      const video = videoRef.current;
      const fsEl = document.fullscreenElement;
      setIsFullscreen(Boolean(fsEl && (fsEl === container || fsEl === video)));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || userPausedRef.current) {
      userPausedRef.current = false;
      // Jump to live edge on resume so latency does not accumulate while paused
      if (video.buffered && video.buffered.length > 0) {
        try {
          const end = video.buffered.end(video.buffered.length - 1);
          if (Number.isFinite(end) && end - video.currentTime > 1.2) {
            video.currentTime = Math.max(0, end - 0.55);
          }
        } catch {
          // Ignore seek errors
        }
      }
      video.muted = mutedRef.current;
      video.volume = volumeRef.current;
      void video.play().catch(() => {});
      setIsPaused(false);
    } else {
      userPausedRef.current = true;
      video.pause();
      setIsPaused(true);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
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
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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

    video.muted = mutedRef.current;
    video.volume = volumeRef.current;
    setLiveBadge(activeProtocol);

    const triggerSeamlessReconnect = () => {
      if (disposed || reconnectTriggered || userPausedRef.current) return;
      reconnectTriggered = true;
      if (onAutoReconnectRef.current) {
        onAutoReconnectRef.current();
      } else {
        onErrorRef.current?.('直播流连接已断开，正在重连');
      }
    };

    const jumpToLiveEdgeAndPlay = (v: HTMLVideoElement) => {
      if (v.buffered && v.buffered.length > 0) {
        try {
          const end = v.buffered.end(v.buffered.length - 1);
          const start = v.buffered.start(0);
          if (Number.isFinite(end) && end > 0) {
            const target = Math.max(start, end - 0.6);
            if (Math.abs(v.currentTime - target) > 0.25) {
              v.currentTime = target;
            }
          }
        } catch {
          // Ignore seek errors
        }
      }
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
          jumpToLiveEdgeAndPlay(v);
        }
      }, 280);
    };
    const handleEnded = () => {
      if (!disposed && !userPausedRef.current) {
        triggerSeamlessReconnect();
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
            enableStashBuffer: false,
            stashInitialSize: 64,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 2.6,
            liveBufferLatencyMinRemain: 0.7,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 20,
            autoCleanupMinBackwardDuration: 10,
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
        flvPlayer.on(mpegts.Events.LOADING_COMPLETE, () => {
          if (!disposed && !userPausedRef.current) {
            triggerSeamlessReconnect();
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
        enableWorker: false,
        lowLatencyMode: true,
        startFragPrefetch: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        backBufferLength: 10,
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
        if (recoverTries < 2) {
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
        bufEnd = v.buffered.end(v.buffered.length - 1);
        const drift = bufEnd - v.currentTime;

        // Rescue if currentTime fell behind cleaned SourceBuffer range (buffer gap stall)
        if (!userPausedRef.current && v.currentTime < firstStart - 0.05) {
          jumpToLiveEdgeAndPlay(v);
        } else if (Number.isFinite(drift) && drift >= 0) {
          latencySec = Math.round(drift * 10) / 10;
          // Only manually chase drift on FLV; hls.js manages its own live sync window
          if (activeProtocol === 'FLV' && drift > 3.2 && !v.paused && !userPausedRef.current) {
            try {
              v.currentTime = Math.max(v.currentTime, bufEnd - 0.65);
            } catch {
              // Ignore seek errors
            }
          }
        }
      }

      // Watchdog for long playback: detect unexpected pause or frozen frames while user did NOT pause
      if (!userPausedRef.current) {
        if (v.paused && hasBuffer && v.readyState >= 2) {
          jumpToLiveEdgeAndPlay(v);
        }

        if (v.readyState >= 2 && v.videoWidth > 0) {
          if (lastObservedTime >= 0 && Math.abs(v.currentTime - lastObservedTime) < 0.05) {
            stalledTicks += 1;
            if (stalledTicks === 2 && hasBuffer && bufEnd > 0) {
              // Soft rescue: jump over micro buffer gap and resume playback
              jumpToLiveEdgeAndPlay(v);
            } else if (stalledTicks >= 5) {
              // Hard stall (~7.5s frozen): TCP socket stalled or signed URL expired -> reconnect cleanly
              triggerSeamlessReconnect();
              return;
            }
          } else {
            stalledTicks = 0;
          }
          lastObservedTime = v.currentTime;
        }
      } else {
        stalledTicks = 0;
      }

      if (v.readyState >= 2 && v.videoWidth > 0) {
        setVideoReady(true);
        if (stalledTicks === 0 && !v.paused) {
          onPlayingRef.current?.();
        }
      }
      const resolution =
        v.videoWidth && v.videoHeight ? `${v.videoWidth}×${v.videoHeight}` : undefined;
      const resTag = v.videoHeight ? `${Math.min(v.videoWidth, v.videoHeight)}P` : '';
      setLiveBadge(
        [resTag, activeProtocol, latencySec !== null ? `${latencySec}s` : '']
          .filter(Boolean)
          .join(' · ')
      );
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
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // Ignore
      }
    };
  }, [flvUrl, hlsUrl, useHlsFallback, reloadToken]);

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

  return (
    <div
      ref={containerRef}
      className={`direct-player-root ${isPaused ? 'is-paused' : ''} ${isFullscreen ? 'is-fullscreen' : ''} ${
        dmPanelOpen ? 'dm-menu-open' : ''
      }`}
      tabIndex={0}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) < 4) return;
        e.preventDefault();
        applyVolumeDelta(e.deltaY < 0 ? 0.05 : -0.05);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && dmPanelOpen) {
          setDmPanelOpen(false);
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
        incomingBatch={danmakuBatch}
        enabled={danmakuEnabled}
        paused={isPaused}
        area={danmakuArea}
        opacity={danmakuOpacity}
        fontSize={danmakuFontSize}
        speed={danmakuSpeed}
        mode={danmakuMode}
        blockKeywords={danmakuBlockKeywords}
      />

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
            className="direct-ctrl-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? '退出全屏 (Esc / F)' : '全屏观看 (双击画面 / F)'}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
