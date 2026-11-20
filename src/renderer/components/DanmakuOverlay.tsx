import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { DanmakuArea, DanmakuMessage, DanmakuMode } from '../../shared/types';

interface CanvasBullet {
  id: string;
  text: string;
  color: string;
  lane: number;
  x: number;
  width: number;
  speedPxPerSec: number;
}

interface DanmakuOverlayProps {
  streamKey?: string;
  incomingBatch: DanmakuMessage[];
  enabled: boolean;
  paused: boolean;
  area?: DanmakuArea;
  opacity?: number;
  fontSize?: number;
  speed?: number;
  mode?: DanmakuMode;
  blockKeywords?: string[];
}

const AREA_RATIO: Record<DanmakuArea, number> = {
  third: 0.34,
  half: 0.52,
  full: 0.9,
};

const MAX_CANVAS_BULLETS = 90;
const MAX_CHAT_MESSAGES = 45;

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

export const DanmakuOverlay = memo(function DanmakuOverlay({
  streamKey = '',
  incomingBatch,
  enabled,
  paused,
  area = 'half',
  opacity = 0.85,
  fontSize = 18,
  speed = 1,
  mode = 'scroll',
  blockKeywords = [],
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

  const safeOpacity = Math.max(0.15, Math.min(1, Number.isFinite(opacity) ? opacity : 0.85));
  const safeFontSize = Math.max(12, Math.min(28, Number.isFinite(fontSize) ? fontSize : 18));
  const safeSpeed = Math.max(0.6, Math.min(1.6, Number.isFinite(speed) ? speed : 1));
  const areaRatio = AREA_RATIO[area] ?? AREA_RATIO.half;

  const matchers = useMemo(() => compileMatchers(blockKeywords), [blockKeywords]);
  const matchersRef = useRef(matchers);
  matchersRef.current = matchers;

  const styleRef = useRef({ safeOpacity, safeFontSize, safeSpeed, areaRatio, paused });
  styleRef.current = { safeOpacity, safeFontSize, safeSpeed, areaRatio, paused };

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
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [streamKey]);

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
        if (bulletsRef.current.length > 0) {
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

  // Start / drive requestAnimationFrame rendering loop for Canvas mode
  const ensureLoop = useRef<() => void>(() => {});
  ensureLoop.current = () => {
    if (rafRef.current !== null) return;
    lastFrameRef.current = performance.now();

    const tick = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !enabled || mode !== 'scroll') {
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

      const cfg = styleRef.current;
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
      ctx.font = `600 ${effFont}px -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei UI", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2.2, effFont * 0.14);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.84)';

      const alive: CanvasBullet[] = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!cfg.paused) {
          b.x -= b.speedPxPerSec * cfg.safeSpeed * dt;
        }
        if (b.x + b.width < -12) continue;
        if (b.lane >= maxLanes) continue;

        const y = 8 + b.lane * lineHeight;
        ctx.strokeText(b.text, b.x, y);
        ctx.fillStyle = b.color;
        ctx.fillText(b.text, b.x, y);
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

  // Re-trigger render when unpaused or style changes
  useEffect(() => {
    if (!enabled || mode !== 'scroll') return;
    if (bulletsRef.current.length > 0) {
      ensureLoop.current();
    }
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, mode, paused, safeOpacity, safeFontSize, safeSpeed, area]);

  // Consume incoming batches for both Canvas scroll mode and Mini Chat mode
  useEffect(() => {
    if (!enabled || incomingBatch.length === 0) return;

    const activeMatchers = matchersRef.current;
    const filtered: DanmakuMessage[] = [];
    for (const msg of incomingBatch) {
      if (!msg.text || seenIdsRef.current.has(msg.id)) continue;
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

    if (mode === 'chat') {
      if (paused) return;
      setChatMessages((prev) => {
        const next = [...prev, ...filtered];
        return next.length > MAX_CHAT_MESSAGES ? next.slice(next.length - MAX_CHAT_MESSAGES) : next;
      });
      return;
    }

    if (paused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;
    if (w <= 10 || h <= 10) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const effFont = computeEffectiveFontSize(w, styleRef.current.safeFontSize);
    const lineHeight = Math.round(effFont * 1.42);
    const maxLanes = Math.max(2, Math.floor((h - 14) / lineHeight));
    ctx.font = `600 ${effFont}px -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei UI", sans-serif`;

    const existing = bulletsRef.current;
    let added = 0;

    for (const msg of filtered) {
      if (added >= 10) break;
      const textWidth = Math.ceil(ctx.measureText(msg.text).width);
      // Base speed scales gently with viewport width & bullet length so bullets stay readable
      const baseSpeed = Math.max(96, w * 0.14) + Math.min(42, textWidth * 0.12);
      const spawnX = w + 12 + added * 16;

      // Find the first lane where the rightmost bullet has cleared the right edge AND won't be caught up mid-screen
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

      existing.push({
        id: msg.id,
        text: msg.text,
        color: msg.color || '#ffffff',
        lane: chosenLane,
        x: spawnX,
        width: textWidth,
        speedPxPerSec: baseSpeed,
      });
      added += 1;
    }

    if (existing.length > MAX_CANVAS_BULLETS) {
      existing.splice(0, existing.length - MAX_CANVAS_BULLETS);
    }

    if (added > 0) {
      ensureLoop.current();
    }
  }, [incomingBatch, enabled, paused, mode]);

  // Auto-scroll mini chat stream unless hovered
  useEffect(() => {
    if (mode !== 'chat' || chatHovered) return;
    const el = chatScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessages, mode, chatHovered]);

  if (!enabled) return null;

  if (mode === 'chat') {
    return (
      <div
        className="danmaku-chat-panel"
        style={{ opacity: Math.min(1, safeOpacity + 0.08) }}
        onMouseEnter={() => setChatHovered(true)}
        onMouseLeave={() => setChatHovered(false)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
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
