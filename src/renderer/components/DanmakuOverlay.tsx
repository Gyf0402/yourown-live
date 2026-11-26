import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, KeyRound, Send } from 'lucide-react';
import type {
  DanmakuArea,
  DanmakuMessage,
  DanmakuMode,
  PlatformId,
  SendDanmakuResult,
} from '../../shared/types';

interface CanvasBullet {
  id: string;
  text: string;
  color: string;
  lane: number;
  x: number;
  width: number;
  speedPxPerSec: number;
  sprite: HTMLCanvasElement | null;
  spriteW: number;
  spriteH: number;
  spriteFont: number;
  spriteDpr: number;
}

interface DanmakuOverlayProps {
  slotIndex: number;
  platform?: PlatformId;
  isPlatformLoggedIn?: boolean;
  streamKey?: string;
  enabled: boolean;
  paused: boolean;
  isObscured?: boolean;
  area?: DanmakuArea;
  opacity?: number;
  fontSize?: number;
  speed?: number;
  mode?: DanmakuMode;
  blockKeywords?: string[];
  onSendDanmaku?: (text: string) => Promise<SendDanmakuResult>;
  onLoginPlatform?: (platform: PlatformId) => void;
  onSwitchToWebMode?: () => void;
}

const AREA_RATIO: Record<DanmakuArea, number> = {
  third: 0.34,
  half: 0.52,
  full: 0.9,
};

const MAX_CANVAS_BULLETS = 90;
const MAX_CHAT_MESSAGES = 45;
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei UI", sans-serif';

function compileMatchers(keywords: string[]): Array<(text: string) => boolean> {
  const matchers: Array<(text: string) => boolean> = [];
  for (const raw of keywords) {
    const k = raw.trim();
    if (!k) continue;
    if (k.length >= 2 && k.startsWith('/') && k.endsWith('/')) {
      try {
        const re = new RegExp(k.slice(1, -1), 'i');
        matchers.push((t) => re.test(t));
        continue;
      } catch {
        // Fallback to plain substring match
      }
    }
    const lower = k.toLowerCase();
    matchers.push((t) => t.toLowerCase().includes(lower));
  }
  return matchers;
}

function buildBulletSprite(
  text: string,
  color: string,
  textWidth: number,
  effFont: number,
  dpr: number
): { canvas: HTMLCanvasElement; w: number; h: number } | null {
  const lineWidth = Math.max(2.2, effFont * 0.14);
  const padX = Math.ceil(lineWidth) + 2;
  const padY = Math.ceil(lineWidth) + 2;
  const logicalW = Math.max(4, Math.ceil(textWidth + padX * 2));
  const logicalH = Math.max(4, Math.ceil(effFont * 1.35 + padY * 2));

  const off = document.createElement('canvas');
  off.width = Math.ceil(logicalW * dpr);
  off.height = Math.ceil(logicalH * dpr);
  const octx = off.getContext('2d');
  if (!octx) return null;

  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.font = `600 ${effFont}px ${FONT_FAMILY}`;
  octx.textBaseline = 'top';
  octx.lineJoin = 'round';
  octx.lineWidth = lineWidth;
  octx.strokeStyle = 'rgba(0, 0, 0, 0.84)';
  octx.strokeText(text, padX, padY);
  octx.fillStyle = color;
  octx.fillText(text, padX, padY);

  return { canvas: off, w: logicalW, h: logicalH };
}

export const DanmakuOverlay = memo(function DanmakuOverlay({
  slotIndex,
  platform,
  isPlatformLoggedIn = false,
  streamKey = '',
  enabled,
  paused,
  isObscured = false,
  area = 'half',
  opacity = 0.85,
  fontSize = 18,
  speed = 1,
  mode = 'scroll',
  blockKeywords = [],
  onSendDanmaku,
  onLoginPlatform,
  onSwitchToWebMode,
}: DanmakuOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bulletsRef = useRef<CanvasBullet[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [chatHovered, setChatHovered] = useState(false);
  const [chatMessages, setChatMessages] = useState<DanmakuMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatCooldown, setChatCooldown] = useState(false);
  const chatCooldownRef = useRef<number | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);

  const safeOpacity = Math.max(0.15, Math.min(1, Number.isFinite(opacity) ? opacity : 0.85));
  const safeFontSize = Math.max(12, Math.min(28, Number.isFinite(fontSize) ? fontSize : 18));
  const safeSpeed = Math.max(0.6, Math.min(1.6, Number.isFinite(speed) ? speed : 1));
  const areaRatio = AREA_RATIO[area] ?? AREA_RATIO.half;

  const matchers = useMemo(() => compileMatchers(blockKeywords), [blockKeywords]);
  const matchersRef = useRef(matchers);
  matchersRef.current = matchers;

  const styleRef = useRef({
    safeOpacity,
    safeFontSize,
    safeSpeed,
    areaRatio,
    paused,
    enabled,
    mode,
    isObscured,
  });
  styleRef.current = {
    safeOpacity,
    safeFontSize,
    safeSpeed,
    areaRatio,
    paused,
    enabled,
    mode,
    isObscured,
  };

  const computeEffectiveFontSize = (width: number, baseFont: number) => {
    if (width <= 0) return baseFont;
    const scale = width < 520 ? Math.max(0.72, width / 560) : 1;
    return Math.max(11, Math.round(baseFont * scale));
  };

  // Clear stale bullets, mini-chat & seen IDs when switching to a different room/stream
  useEffect(() => {
    bulletsRef.current = [];
    seenIdsRef.current.clear();
    setChatMessages([]);
    setChatInput('');
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [streamKey]);

  useEffect(() => {
    return () => {
      if (chatCooldownRef.current !== null) {
        window.clearTimeout(chatCooldownRef.current);
      }
    };
  }, []);

  // Clear visible bullets & mini-chat when danmaku is toggled off (without forgetting already-seen message IDs)
  useEffect(() => {
    if (enabled) return;
    bulletsRef.current = [];
    setChatMessages([]);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [enabled]);

  // ResizeObserver for high-DPI canvas sizing (always sync actual DOM canvas.width/height on remount!)
  useEffect(() => {
    if (!enabled || mode !== 'scroll') {
      sizeRef.current = { w: 0, h: 0, dpr: 1 };
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const targetW = Math.floor(w * dpr);
      const targetH = Math.floor(h * dpr);
      if (
        sizeRef.current.w !== w ||
        sizeRef.current.h !== h ||
        sizeRef.current.dpr !== dpr ||
        canvas.width !== targetW ||
        canvas.height !== targetH
      ) {
        sizeRef.current = { w, h, dpr };
        canvas.width = targetW;
        canvas.height = targetH;
        if (bulletsRef.current.length > 0 && !document.hidden && !styleRef.current.isObscured) {
          ensureLoop.current();
        }
      }
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      sizeRef.current = { w: 0, h: 0, dpr: 1 };
    };
  }, [enabled, mode, area]);

  // Start / drive requestAnimationFrame rendering loop for Canvas mode (using pre-rendered bullet sprites)
  const ensureLoop = useRef<() => void>(() => {});
  ensureLoop.current = () => {
    if (rafRef.current !== null) return;
    if (document.hidden || styleRef.current.isObscured) return;
    lastFrameRef.current = performance.now();

    const tick = (now: number) => {
      const cfg = styleRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !cfg.enabled || cfg.mode !== 'scroll' || document.hidden || cfg.isObscured) {
        rafRef.current = null;
        return;
      }

      const dt = Math.min(0.08, Math.max(0, (now - lastFrameRef.current) / 1000));
      lastFrameRef.current = now;

      const { w, h, dpr } = sizeRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx || w <= 0 || h <= 0) {
        rafRef.current = null;
        return;
      }

      const effFont = computeEffectiveFontSize(w, cfg.safeFontSize);
      const lineHeight = Math.round(effFont * 1.42);
      const maxLanes = Math.max(2, Math.floor((h - 14) / lineHeight));

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const list = bulletsRef.current;
      if (list.length === 0) {
        rafRef.current = null;
        return;
      }

      ctx.globalAlpha = cfg.safeOpacity;
      const padOffset = Math.ceil(Math.max(2.2, effFont * 0.14)) + 2;

      const alive: CanvasBullet[] = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!cfg.paused) {
          b.x -= b.speedPxPerSec * cfg.safeSpeed * dt;
        }
        if (b.x + b.width < -12) {
          b.sprite = null;
          continue;
        }
        if (b.lane >= maxLanes) {
          b.sprite = null;
          continue;
        }

        // Rebuild cached sprite only if font size or DPR changed
        if (!b.sprite || b.spriteFont !== effFont || b.spriteDpr !== dpr) {
          const built = buildBulletSprite(b.text, b.color, b.width, effFont, dpr);
          if (built) {
            b.sprite = built.canvas;
            b.spriteW = built.w;
            b.spriteH = built.h;
            b.spriteFont = effFont;
            b.spriteDpr = dpr;
          }
        }

        const y = 8 + b.lane * lineHeight;
        if (b.sprite) {
          ctx.drawImage(
            b.sprite,
            0,
            0,
            b.sprite.width,
            b.sprite.height,
            Math.round(b.x - padOffset),
            Math.round(y - padOffset),
            b.spriteW,
            b.spriteH
          );
        }
        alive.push(b);
      }

      bulletsRef.current = alive;
      if (alive.length > 0 && !cfg.paused) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = window.requestAnimationFrame(tick);
  };

  // Re-trigger render when unpaused, visibility restored, or style changes; stop rAF immediately when hidden
  useEffect(() => {
    if (!enabled || mode !== 'scroll' || isObscured) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const handleVisibility = () => {
      if (document.hidden) {
        if (rafRef.current !== null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      } else if (bulletsRef.current.length > 0 && !styleRef.current.paused && !styleRef.current.isObscured) {
        ensureLoop.current();
      }
    };

    if (!document.hidden && bulletsRef.current.length > 0) {
      ensureLoop.current();
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, mode, paused, isObscured, safeOpacity, safeFontSize, safeSpeed, area]);

  // Subscribe directly to main-process danmaku IPC batches so incoming bursts NEVER re-render LivePane/DirectPlayer
  useEffect(() => {
    if (!enabled || typeof window.livehub?.onDanmakuBatch !== 'function') return;

    const unsub = window.livehub.onDanmakuBatch((batch) => {
      const cfg = styleRef.current;
      if (!cfg.enabled || cfg.paused) return;

      const activeMatchers = matchersRef.current;
      const filtered: DanmakuMessage[] = [];
      for (let i = 0; i < batch.length; i++) {
        const msg = batch[i];
        if (msg.slotIndex !== slotIndex || !msg.text || seenIdsRef.current.has(msg.id)) continue;
        seenIdsRef.current.add(msg.id);
        if (activeMatchers.length > 0 && activeMatchers.some((fn) => fn(msg.text))) {
          continue;
        }
        filtered.push(msg);
      }

      if (seenIdsRef.current.size > 500) {
        seenIdsRef.current = new Set(Array.from(seenIdsRef.current).slice(-250));
      }
      if (filtered.length === 0) return;

      if (cfg.mode === 'chat') {
        setChatMessages((prev) => {
          const next = [...prev, ...filtered];
          return next.length > MAX_CHAT_MESSAGES ? next.slice(next.length - MAX_CHAT_MESSAGES) : next;
        });
        return;
      }

      // Skip building scroll sprites & running Canvas while pane or window is invisible
      if (document.hidden || cfg.isObscured) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const { w, h, dpr } = sizeRef.current;
      if (w <= 10 || h <= 10) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const effFont = computeEffectiveFontSize(w, cfg.safeFontSize);
      const lineHeight = Math.round(effFont * 1.42);
      const maxLanes = Math.max(2, Math.floor((h - 14) / lineHeight));
      ctx.font = `600 ${effFont}px ${FONT_FAMILY}`;

      const existing = bulletsRef.current;
      let added = 0;

      for (const msg of filtered) {
        if (added >= 10) break;
        const textWidth = Math.ceil(ctx.measureText(msg.text).width);
        const baseSpeed = Math.max(96, w * 0.14) + Math.min(42, textWidth * 0.12);
        const spawnX = w + 12 + added * 16;

        let chosenLane = -1;
        for (let lane = 0; lane < maxLanes; lane++) {
          let rightmost: CanvasBullet | null = null;
          let rightmostTail = -Infinity;
          for (let i = 0; i < existing.length; i++) {
            const b = existing[i];
            if (b.lane === lane) {
              const tail = b.x + b.width;
              if (tail > rightmostTail) {
                rightmostTail = tail;
                rightmost = b;
              }
            }
          }
          if (rightmostTail >= w - 28) continue;
          if (rightmost && baseSpeed > rightmost.speedPxPerSec) {
            const prevExitSec = Math.max(0, rightmostTail / rightmost.speedPxPerSec);
            const newHeadAtExit = spawnX - baseSpeed * prevExitSec;
            if (newHeadAtExit < 24) continue;
          }
          chosenLane = lane;
          break;
        }
        if (chosenLane === -1) continue;

        const color = msg.color || '#ffffff';
        const built = buildBulletSprite(msg.text, color, textWidth, effFont, dpr);

        existing.push({
          id: msg.id,
          text: msg.text,
          color,
          lane: chosenLane,
          x: spawnX,
          width: textWidth,
          speedPxPerSec: baseSpeed,
          sprite: built?.canvas ?? null,
          spriteW: built?.w ?? textWidth,
          spriteH: built?.h ?? lineHeight,
          spriteFont: effFont,
          spriteDpr: dpr,
        });
        added += 1;
      }

      if (existing.length > MAX_CANVAS_BULLETS) {
        existing.splice(0, existing.length - MAX_CANVAS_BULLETS);
      }

      if (added > 0) {
        ensureLoop.current();
      }
    });

    return () => {
      unsub();
    };
  }, [enabled, slotIndex]);

  // Auto-scroll mini chat stream unless hovered
  useEffect(() => {
    if (mode !== 'chat' || chatHovered) return;
    const el = chatScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessages, mode, chatHovered]);

  const handleSubmitChatInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSendDanmaku || chatSending || chatCooldown) return;
    const clean = chatInput.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    setChatSending(true);
    try {
      const res = await onSendDanmaku(clean);
      if (res.ok) {
        setChatInput('');
        setChatCooldown(true);
        if (chatCooldownRef.current !== null) {
          window.clearTimeout(chatCooldownRef.current);
        }
        chatCooldownRef.current = window.setTimeout(() => {
          chatCooldownRef.current = null;
          setChatCooldown(false);
        }, 1500);
      }
    } finally {
      setChatSending(false);
      window.setTimeout(() => chatInputRef.current?.focus(), 0);
    }
  };

  if (!enabled) return null;

  if (mode === 'chat') {
    const canDirectSend = platform === 'bilibili';
    return (
      <div
        className="danmaku-chat-panel"
        style={{ opacity: Math.min(1, safeOpacity + 0.08) }}
        onMouseEnter={() => setChatHovered(true)}
        onMouseLeave={() => setChatHovered(false)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="danmaku-chat-scroll" ref={chatScrollRef}>
          {chatMessages.length === 0 ? (
            <div className="danmaku-chat-empty">等待弹幕流入...</div>
          ) : (
            chatMessages.map((m) => (
              <div
                key={m.id}
                className="danmaku-chat-row"
                style={{ fontSize: Math.max(11, Math.min(15, safeFontSize - 5)) }}
              >
                {m.user && <span className="danmaku-chat-user">{m.user}：</span>}
                <span className="danmaku-chat-text" style={m.color ? { color: m.color } : undefined}>
                  {m.text}
                </span>
              </div>
            ))
          )}
        </div>

        {platform && onSendDanmaku && (
          <div className="danmaku-chat-composer">
            {canDirectSend ? (
              isPlatformLoggedIn ? (
                <form
                  className="danmaku-chat-composer-form"
                  onSubmit={(e) => void handleSubmitChatInput(e)}
                >
                  <input
                    ref={chatInputRef}
                    className="danmaku-chat-input"
                    value={chatInput}
                    maxLength={40}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={chatCooldown ? '稍候片刻...' : '发条弹幕 (Enter)...'}
                    disabled={chatSending}
                  />
                  <button
                    type="submit"
                    className="danmaku-chat-send-btn"
                    disabled={chatSending || chatCooldown || !chatInput.trim()}
                    title="直接发送 B站弹幕"
                  >
                    <Send size={12} />
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="danmaku-chat-helper-btn"
                  onClick={() => onLoginPlatform?.('bilibili')}
                >
                  <KeyRound size={11} />
                  <span>登录 B站后可直接发弹幕</span>
                </button>
              )
            ) : (
              <div className="danmaku-chat-helper-row">
                <span>直连发弹幕暂仅支持 B站</span>
                {onSwitchToWebMode && (
                  <button
                    type="button"
                    className="danmaku-chat-switch-btn"
                    onClick={onSwitchToWebMode}
                  >
                    <Globe size={10} />
                    <span>切网页发</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="danmaku-canvas-layer"
      style={{ height: `${Math.round(areaRatio * 100)}%` }}
      aria-hidden="true"
    />
  );
});
