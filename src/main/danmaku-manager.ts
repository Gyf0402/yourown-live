import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { BrowserWindow, type Session } from 'electron';
import WebSocket from 'ws';
import type { DanmakuMessage, DanmakuStatusEvent, PlatformId } from '../shared/types';
import { recordDiagnostic } from './diagnostics';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const BILI_WBI_MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const DOUYU_COLORS: Record<string, string> = {
  '1': '#ff4d4f',
  '2': '#38bdf8',
  '3': '#4ade80',
  '4': '#fb923c',
  '5': '#c084fc',
  '6': '#f472b6',
};

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 7000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ==================== Minimal Protobuf Wire Codec (Douyin) ====================
interface ProtoField {
  fieldNum: number;
  wireType: number;
  val?: bigint;
  buf?: Buffer;
}

function readVarint(buf: Buffer, offset: number): { val: bigint; next: number } {
  let val = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { val, next: pos };
}

function parseProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    pos = tagRes.next;
    const fieldNum = Number(tagRes.val >> 3n);
    const wireType = Number(tagRes.val & 7n);
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
      fields.push({ fieldNum, wireType, val: v.val });
    } else if (wireType === 1) {
      fields.push({ fieldNum, wireType, buf: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wireType === 2) {
      const l = readVarint(buf, pos);
      pos = l.next;
      const len = Number(l.val);
      if (len < 0 || pos + len > buf.length) break;
      fields.push({ fieldNum, wireType, buf: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wireType === 5) {
      fields.push({ fieldNum, wireType, buf: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function encodeVarint(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

function encodeProtoBytes(fieldNum: number, bytes: Buffer): Buffer {
  return Buffer.concat([
    encodeVarint((BigInt(fieldNum) << 3n) | 2n),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

function encodeProtoVarint(fieldNum: number, val: number | bigint): Buffer {
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 0n), encodeVarint(val)]);
}

// ==================== Minimal Tars Wire Codec (Huya) ====================
function tarsWriteHead(type: number, tag: number): Buffer {
  if (tag < 15) return Buffer.from([(tag << 4) | type]);
  return Buffer.from([(15 << 4) | type, tag]);
}

function tarsWriteInt(tag: number, val: number | bigint): Buffer {
  const n = BigInt(val);
  if (n === 0n) return tarsWriteHead(12, tag);
  if (n >= -128n && n <= 127n) {
    const b = Buffer.alloc(1);
    b.writeInt8(Number(n));
    return Buffer.concat([tarsWriteHead(0, tag), b]);
  }
  if (n >= -32768n && n <= 32767n) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(Number(n));
    return Buffer.concat([tarsWriteHead(1, tag), b]);
  }
  if (n >= -2147483648n && n <= 2147483647n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Number(n));
    return Buffer.concat([tarsWriteHead(2, tag), b]);
  }
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n);
  return Buffer.concat([tarsWriteHead(3, tag), b]);
}

function tarsWriteString(tag: number, s: string): Buffer {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length < 256) {
    return Buffer.concat([tarsWriteHead(6, tag), Buffer.from([buf.length]), buf]);
  }
  const l = Buffer.alloc(4);
  l.writeUInt32BE(buf.length);
  return Buffer.concat([tarsWriteHead(7, tag), l, buf]);
}

function tarsWriteBytes(tag: number, buf: Buffer): Buffer {
  return Buffer.concat([
    tarsWriteHead(13, tag),
    tarsWriteHead(0, 0),
    tarsWriteInt(0, buf.length),
    buf,
  ]);
}

function tarsWriteList(tag: number, items: Buffer[]): Buffer {
  return Buffer.concat([tarsWriteHead(9, tag), tarsWriteInt(0, items.length), ...items]);
}

function tarsReadFields(
  buf: Buffer,
  start = 0,
  end = buf.length
): Map<number, bigint | string | Buffer> {
  const map = new Map<number, bigint | string | Buffer>();
  let pos = start;

  const readHead = () => {
    const b = buf[pos++];
    const type = b & 0x0f;
    let tag = (b & 0xf0) >> 4;
    if (tag === 15) tag = buf[pos++];
    return { type, tag };
  };

  const readIntVal = (type: number): bigint => {
    if (type === 12) return 0n;
    if (type === 0) return BigInt(buf.readInt8(pos++));
    if (type === 1) {
      const v = BigInt(buf.readInt16BE(pos));
      pos += 2;
      return v;
    }
    if (type === 2) {
      const v = BigInt(buf.readInt32BE(pos));
      pos += 4;
      return v;
    }
    if (type === 3) {
      const v = buf.readBigInt64BE(pos);
      pos += 8;
      return v;
    }
    return 0n;
  };

  const skipField = (type: number) => {
    if (type === 0) pos += 1;
    else if (type === 1) pos += 2;
    else if (type === 2 || type === 4) pos += 4;
    else if (type === 3 || type === 5) pos += 8;
    else if (type === 6) {
      const l = buf[pos++];
      pos += l;
    } else if (type === 7) {
      const l = buf.readUInt32BE(pos);
      pos += 4 + l;
    } else if (type === 8) {
      const cnt = Number(readIntVal(readHead().type));
      for (let i = 0; i < cnt * 2; i++) skipField(readHead().type);
    } else if (type === 9) {
      const cnt = Number(readIntVal(readHead().type));
      for (let i = 0; i < cnt; i++) skipField(readHead().type);
    } else if (type === 10) {
      while (pos < end) {
        const h = readHead();
        if (h.type === 11) break;
        skipField(h.type);
      }
    } else if (type === 13) {
      readHead();
      const cnt = Number(readIntVal(readHead().type));
      pos += cnt;
    }
  };

  while (pos < end) {
    const { type, tag } = readHead();
    if (type === 11) break;
    if (type === 0 || type === 1 || type === 2 || type === 3 || type === 12) {
      map.set(tag, readIntVal(type));
    } else if (type === 6) {
      const l = buf[pos++];
      map.set(tag, buf.subarray(pos, pos + l).toString('utf-8'));
      pos += l;
    } else if (type === 7) {
      const l = buf.readUInt32BE(pos);
      pos += 4;
      map.set(tag, buf.subarray(pos, pos + l).toString('utf-8'));
      pos += l;
    } else if (type === 13) {
      readHead();
      const l = Number(readIntVal(readHead().type));
      map.set(tag, buf.subarray(pos, pos + l));
      pos += l;
    } else if (type === 10) {
      const subStart = pos;
      let depth = 1;
      while (pos < end && depth > 0) {
        const h = readHead();
        if (h.type === 10) depth++;
        else if (h.type === 11) depth--;
        else skipField(h.type);
      }
      map.set(tag, buf.subarray(subStart, pos - 1));
    } else {
      skipField(type);
    }
  }
  return map;
}

// ==================== Douyin Ephemeral Webmssdk Signer ====================
let cachedDouyinSdk: { ttwid: string; sdkCode: string; expiresAt: number } | null = null;
let signerWin: BrowserWindow | null = null;
let signerReadyPromise: Promise<BrowserWindow> | null = null;
let signerIdleTimer: NodeJS.Timeout | null = null;

function destroyDouyinSigner(): void {
  if (signerIdleTimer) {
    clearTimeout(signerIdleTimer);
    signerIdleTimer = null;
  }
  if (signerWin && !signerWin.isDestroyed()) {
    try {
      signerWin.destroy();
    } catch {
      // Ignore
    }
    signerWin = null;
  }
}

function touchDouyinSignerIdle(): void {
  if (signerIdleTimer) clearTimeout(signerIdleTimer);
  signerIdleTimer = setTimeout(() => {
    destroyDouyinSigner();
  }, 60_000);
}

async function ensureDouyinSdkInfo(): Promise<{ ttwid: string; sdkCode: string }> {
  const now = Date.now();
  if (cachedDouyinSdk && now < cachedDouyinSdk.expiresAt) {
    return cachedDouyinSdk;
  }
  const homeResp = await fetchWithTimeout('https://live.douyin.com/', {
    headers: { 'User-Agent': DESKTOP_UA },
  });
  const setCookies = homeResp.headers.getSetCookie ? homeResp.headers.getSetCookie() : [];
  const ttwid =
    setCookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('ttwid=')) || '';
  const html = await homeResp.text();
  const sdkMatch = html.match(/(?:https?:)?\/\/[^"'>\s]*webmssdk[^"'>\s]*\.js/);
  const sdkUrl = sdkMatch
    ? sdkMatch[0].startsWith('//')
      ? `https:${sdkMatch[0]}`
      : sdkMatch[0]
    : 'https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.53/webmssdk.es5.js';

  const sdkCode = await fetchWithTimeout(sdkUrl, {
    headers: { 'User-Agent': DESKTOP_UA },
  }).then((r) => r.text());

  cachedDouyinSdk = { ttwid, sdkCode, expiresAt: now + 30 * 60 * 1000 };
  return cachedDouyinSdk;
}

async function getDouyinSignerWindow(sdkCode: string): Promise<BrowserWindow> {
  if (signerWin && !signerWin.isDestroyed()) {
    touchDouyinSignerIdle();
    return signerWin;
  }
  if (signerReadyPromise) return signerReadyPromise;

  signerReadyPromise = (async () => {
    const win = new BrowserWindow({
      width: 120,
      height: 120,
      show: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
        images: false,
      },
    });
    win.webContents.setUserAgent(DESKTOP_UA);
    try {
      await win.loadURL('https://live.douyin.com/robots.txt');
      await win.webContents.executeJavaScript(`(() => { ${sdkCode}; return true; })()`);
    } catch {
      await win.loadURL('data:text/html,<!doctype html><html><body></body></html>');
      await win.webContents.executeJavaScript(sdkCode);
    }
    win.on('closed', () => {
      if (signerWin === win) signerWin = null;
    });
    signerWin = win;
    touchDouyinSignerIdle();
    return win;
  })().finally(() => {
    signerReadyPromise = null;
  });

  return signerReadyPromise;
}

async function signDouyinWsStub(
  roomId: string,
  userUniqueId: string
): Promise<{ signature: string; ttwid: string }> {
  const { ttwid, sdkCode } = await ensureDouyinSdkInfo();
  const win = await getDouyinSignerWindow(sdkCode);
  touchDouyinSignerIdle();
  const rawParams =
    `live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.0.14-beta.0,` +
    `room_id=${roomId},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id=${userUniqueId},` +
    `device_platform=web,device_type=,ac=,identity=audience`;
  const stub = md5(rawParams);
  const sigObj = (await win.webContents.executeJavaScript(`(() => {
    const ac = window.byted_acrawler || window.BDMS;
    if (!ac || typeof ac.frontierSign !== 'function') return null;
    return ac.frontierSign({ "X-MS-STUB": ${JSON.stringify(stub)} });
  })()`)) as Record<string, string> | null;
  return { signature: sigObj?.['X-Bogus'] || '', ttwid };
}

// ==================== Bilibili WBI Cache ====================
let cachedBiliWbi: { imgKey: string; subKey: string; buvid3: string; expiresAt: number } | null =
  null;

async function getBiliWbiInfo(): Promise<{ imgKey: string; subKey: string; buvid3: string }> {
  const now = Date.now();
  if (cachedBiliWbi && now < cachedBiliWbi.expiresAt) return cachedBiliWbi;

  const [nav, spi] = await Promise.all([
    fetchWithTimeout('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': DESKTOP_UA },
    }).then((r) => r.json()) as Promise<{
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    }>,
    fetchWithTimeout('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': DESKTOP_UA },
    }).then((r) => r.json()) as Promise<{ data?: { b_3?: string } }>,
  ]);

  const imgKey = (nav?.data?.wbi_img?.img_url || '').split('/').pop()?.split('.')[0] || '';
  const subKey = (nav?.data?.wbi_img?.sub_url || '').split('/').pop()?.split('.')[0] || '';
  const buvid3 = spi?.data?.b_3 || '';
  cachedBiliWbi = { imgKey, subKey, buvid3, expiresAt: now + 30 * 60 * 1000 };
  return cachedBiliWbi;
}

function wbiSignQuery(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string
): string {
  const raw = imgKey + subKey;
  const mixinKey = BILI_WBI_MIXIN.map((i) => raw[i] || '')
    .join('')
    .slice(0, 32);
  const wts = Math.floor(Date.now() / 1000);
  const all: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`
    )
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

// ==================== Manager State ====================
interface ActiveSlotDanmaku {
  slotIndex: number;
  platform: PlatformId;
  roomId: string;
  token: number;
  ws: WebSocket | null;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  retries: number;
  stopped: boolean;
}

export class DanmakuManager {
  private slots = new Map<number, ActiveSlotDanmaku>();
  private seq = 0;
  private msgSeq = 0;
  private pendingBatch: DanmakuMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private emitBatch: (batch: DanmakuMessage[]) => void;
  private emitStatus?: (ev: DanmakuStatusEvent) => void;
  private getSession?: () => Session;

  constructor(
    emitBatch: (batch: DanmakuMessage[]) => void,
    options?: {
      emitStatus?: (ev: DanmakuStatusEvent) => void;
      getSession?: () => Session;
    }
  ) {
    this.emitBatch = emitBatch;
    this.emitStatus = options?.emitStatus;
    this.getSession = options?.getSession;
  }

  private notifyStatus(
    slotIndex: number,
    state: DanmakuStatusEvent['state'],
    platform?: PlatformId,
    message?: string
  ): void {
    this.emitStatus?.({ slotIndex, state, platform, message });
  }

  private enqueue(
    slotIndex: number,
    platform: PlatformId,
    user: string,
    text: string,
    color?: string
  ): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.msgSeq += 1;
    this.pendingBatch.push({
      id: `dm-${slotIndex}-${this.msgSeq}`,
      slotIndex,
      platform,
      user: user.trim(),
      text: clean.slice(0, 80),
      color,
      ts: Date.now(),
    });
    if (this.pendingBatch.length > 60) {
      this.pendingBatch.splice(0, this.pendingBatch.length - 60);
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.pendingBatch.length > 0) {
          const batch = this.pendingBatch.splice(0, this.pendingBatch.length);
          this.emitBatch(batch);
        }
      }, 120);
    }
  }

  public stopSlot(slotIndex: number): void {
    const existing = this.slots.get(slotIndex);
    if (!existing) return;
    existing.stopped = true;
    if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer);
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    if (existing.ws) {
      try {
        existing.ws.removeAllListeners();
        existing.ws.terminate();
      } catch {
        // Ignore
      }
    }
    this.slots.delete(slotIndex);
    this.notifyStatus(slotIndex, 'disconnected', existing.platform);
    // Reclaim Douyin signer window quickly if no Douyin slots remain
    const hasDouyin = Array.from(this.slots.values()).some((s) => s.platform === 'douyin');
    if (!hasDouyin && signerWin && !signerWin.isDestroyed()) {
      touchDouyinSignerIdle();
    }
  }

  public stopAll(): void {
    for (const slotIndex of Array.from(this.slots.keys())) {
      this.stopSlot(slotIndex);
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingBatch = [];
    destroyDouyinSigner();
  }

  public async startSlot(
    slotIndex: number,
    platform: PlatformId,
    roomId: string,
    forceReconnect = false
  ): Promise<{ ok: boolean; error?: string }> {
    const cur = this.slots.get(slotIndex);
    if (
      !forceReconnect &&
      cur &&
      !cur.stopped &&
      cur.platform === platform &&
      cur.roomId === roomId
    ) {
      return { ok: true };
    }
    this.stopSlot(slotIndex);

    const token = ++this.seq;
    const entry: ActiveSlotDanmaku = {
      slotIndex,
      platform,
      roomId,
      token,
      ws: null,
      heartbeatTimer: null,
      reconnectTimer: null,
      retries: 0,
      stopped: false,
    };
    this.slots.set(slotIndex, entry);
    this.notifyStatus(slotIndex, 'connecting', platform, '正在连接弹幕...');

    try {
      await this.connectEntry(entry);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '弹幕连接失败';
      recordDiagnostic('warn', 'danmaku', `[槽位${slotIndex + 1} ${platform}#${roomId}] ${msg}`);
      this.notifyStatus(slotIndex, 'error', platform, msg);
      this.scheduleReconnect(entry);
      return { ok: false, error: msg };
    }
  }

  private scheduleReconnect(entry: ActiveSlotDanmaku): void {
    if (entry.stopped || this.slots.get(entry.slotIndex)?.token !== entry.token) return;
    if (entry.retries >= 20) {
      recordDiagnostic(
        'error',
        'danmaku',
        `[槽位${entry.slotIndex + 1} ${entry.platform}#${entry.roomId}] 弹幕重连达上限，已停止`
      );
      this.notifyStatus(
        entry.slotIndex,
        'error',
        entry.platform,
        '弹幕多次重连失败，点击重试'
      );
      return;
    }
    entry.retries += 1;
    const delay = Math.min(30_000, Math.round(3000 * Math.pow(1.6, Math.min(entry.retries - 1, 5))));
    this.notifyStatus(
      entry.slotIndex,
      'reconnecting',
      entry.platform,
      `弹幕重连中 (${entry.retries})...`
    );
    entry.reconnectTimer = setTimeout(() => {
      if (entry.stopped || this.slots.get(entry.slotIndex)?.token !== entry.token) return;
      void this.connectEntry(entry).catch((err) => {
        const msg = err instanceof Error ? err.message : '重连异常';
        recordDiagnostic(
          'warn',
          'danmaku',
          `[槽位${entry.slotIndex + 1} ${entry.platform}#${entry.roomId}] 弹幕重连失败：${msg}`
        );
        this.scheduleReconnect(entry);
      });
    }, delay);
  }

  private async connectEntry(entry: ActiveSlotDanmaku): Promise<void> {
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
    if (entry.ws) {
      try {
        entry.ws.removeAllListeners();
        entry.ws.terminate();
      } catch {
        // Ignore
      }
      entry.ws = null;
    }

    switch (entry.platform) {
      case 'douyu':
        await this.connectDouyu(entry);
        break;
      case 'bilibili':
        await this.connectBilibili(entry);
        break;
      case 'huya':
        await this.connectHuya(entry);
        break;
      case 'douyin':
        await this.connectDouyin(entry);
        break;
    }
  }

  // ---------------- 1. Douyu STT ----------------
  private async connectDouyu(entry: ActiveSlotDanmaku): Promise<void> {
    let rid = entry.roomId;
    if (!/^\d+$/.test(rid)) {
      const betard = (await fetchWithTimeout(
        `https://www.douyu.com/betard/${encodeURIComponent(rid)}`,
        { headers: { 'User-Agent': DESKTOP_UA } }
      )
        .then((r) => r.json())
        .catch(() => null)) as { room?: { room_id?: number } } | null;
      if (betard?.room?.room_id) rid = String(betard.room.room_id);
    }
    if (entry.stopped) return;

    const pack = (str: string) => {
      const body = Buffer.from(`${str}\0`, 'utf-8');
      const head = Buffer.alloc(12);
      head.writeUInt32LE(body.length + 8, 0);
      head.writeUInt32LE(body.length + 8, 4);
      head.writeUInt16LE(689, 8);
      return Buffer.concat([head, body]);
    };

    const ws = new WebSocket('wss://danmuproxy.douyu.com:8506/');
    entry.ws = ws;

    ws.on('open', () => {
      entry.retries = 0;
      this.notifyStatus(entry.slotIndex, 'connected', 'douyu');
      recordDiagnostic('info', 'danmaku', `[槽位${entry.slotIndex + 1} douyu#${rid}] 弹幕已连接`);
      ws.send(pack(`type@=loginreq/roomid@=${rid}/`));
      ws.send(pack(`type@=joingroup/rid@=${rid}/gid@=-9999/`));
      entry.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pack('type@=mrkl/'));
      }, 45000);
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      let off = 0;
      while (off + 12 <= buf.length) {
        const len = buf.readUInt32LE(off);
        if (len < 8 || off + 4 + len > buf.length) break;
        const txt = buf.subarray(off + 12, off + 4 + len - 1).toString('utf-8');
        off += 4 + len;
        if (txt.includes('type@=chatmsg/')) {
          const nick = (txt.match(/\/nn@=([^/]*)/)?.[1] || '')
            .replace(/@S/g, '/')
            .replace(/@A/g, '@');
          const content = (txt.match(/\/txt@=([^/]*)/)?.[1] || '')
            .replace(/@S/g, '/')
            .replace(/@A/g, '@');
          const colCode = txt.match(/\/col@=([^/]*)/)?.[1] || '';
          this.enqueue(entry.slotIndex, 'douyu', nick, content, DOUYU_COLORS[colCode]);
        }
      }
    });

    ws.on('close', () => this.scheduleReconnect(entry));
    ws.on('error', () => {});
  }

  // ---------------- 2. Bilibili WBI + Brotli/Zlib ----------------
  private async connectBilibili(entry: ActiveSlotDanmaku): Promise<void> {
    let authCookieHeader = '';
    let authUid = 0;
    let authBuvid3 = '';
    if (this.getSession) {
      try {
        const cookies = await this.getSession().cookies.get({ domain: 'bilibili.com' });
        const allow = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'b_nut']);
        const picked = cookies.filter((c) => allow.has(c.name) && c.value);
        if (picked.length > 0) {
          authCookieHeader = picked.map((c) => `${c.name}=${c.value}`).join('; ');
        }
        const uidVal = cookies.find((c) => c.name === 'DedeUserID')?.value;
        if (uidVal && /^\d+$/.test(uidVal)) authUid = Number(uidVal);
        authBuvid3 = cookies.find((c) => c.name === 'buvid3')?.value || '';
      } catch {
        // Fallback to anonymous WBI
      }
    }

    const [wbi, roomInfo] = await Promise.all([
      getBiliWbiInfo(),
      fetchWithTimeout(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${encodeURIComponent(entry.roomId)}`,
        {
          headers: {
            'User-Agent': DESKTOP_UA,
            ...(authCookieHeader ? { Cookie: authCookieHeader } : {}),
          },
        }
      )
        .then((r) => r.json())
        .catch(() => null) as Promise<{ data?: { room_info?: { room_id?: number } } } | null>,
    ]);
    if (entry.stopped) return;

    const effectiveBuvid3 = authBuvid3 || wbi.buvid3;
    const cookieForDanmu = authCookieHeader
      ? authBuvid3
        ? authCookieHeader
        : effectiveBuvid3
          ? `${authCookieHeader}; buvid3=${effectiveBuvid3}`
          : authCookieHeader
      : effectiveBuvid3
        ? `buvid3=${effectiveBuvid3}`
        : '';

    const realRid = Number(roomInfo?.data?.room_info?.room_id || entry.roomId);
    const qs = wbiSignQuery({ id: realRid, type: 0 }, wbi.imgKey, wbi.subKey);
    const dmInfo = (await fetchWithTimeout(
      `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`,
      {
        headers: {
          'User-Agent': DESKTOP_UA,
          Referer: `https://live.bilibili.com/${realRid}`,
          ...(cookieForDanmu ? { Cookie: cookieForDanmu } : {}),
        },
      }
    ).then((r) => r.json())) as {
      data?: { token?: string; host_list?: Array<{ host: string; wss_port: number }> };
    };
    if (entry.stopped) return;

    const hostObj = dmInfo?.data?.host_list?.[0];
    const wsUrl = hostObj
      ? `wss://${hostObj.host}:${hostObj.wss_port}/sub`
      : 'wss://broadcastlv.chat.bilibili.com:443/sub';
    const token = dmInfo?.data?.token || '';

    const pack = (op: number, body: Buffer) => {
      const head = Buffer.alloc(16);
      head.writeUInt32BE(16 + body.length, 0);
      head.writeUInt16BE(16, 4);
      head.writeUInt16BE(1, 6);
      head.writeUInt32BE(op, 8);
      head.writeUInt32BE(1, 12);
      return Buffer.concat([head, body]);
    };

    const unpack = (buf: Buffer) => {
      let off = 0;
      while (off + 16 <= buf.length) {
        const plen = buf.readUInt32BE(off);
        const hlen = buf.readUInt16BE(off + 4);
        const ver = buf.readUInt16BE(off + 6);
        const op = buf.readUInt32BE(off + 8);
        if (plen < hlen || off + plen > buf.length) break;
        const body = buf.subarray(off + hlen, off + plen);
        off += plen;
        if (op === 5) {
          if (ver === 2) {
            try {
              unpack(zlib.inflateSync(body));
            } catch {
              // Ignore malformed deflate
            }
          } else if (ver === 3) {
            try {
              unpack(zlib.brotliDecompressSync(body));
            } catch {
              // Ignore malformed brotli
            }
          } else {
            try {
              const j = JSON.parse(body.toString('utf-8')) as {
                cmd?: string;
                info?: unknown[];
              };
              if (String(j.cmd || '').startsWith('DANMU_MSG') && Array.isArray(j.info)) {
                const text = String(j.info[1] || '');
                const userArr = Array.isArray(j.info[2]) ? j.info[2] : [];
                const metaArr = Array.isArray(j.info[0]) ? j.info[0] : [];
                const nick = String(userArr[1] || '');
                const decColor = Number(metaArr[3] || 0);
                const hexColor =
                  decColor && decColor !== 16777215
                    ? `#${decColor.toString(16).padStart(6, '0')}`
                    : undefined;
                this.enqueue(entry.slotIndex, 'bilibili', nick, text, hexColor);
              }
            } catch {
              // Ignore non-JSON frames
            }
          }
        }
      }
    };

    const ws = new WebSocket(wsUrl, {
      headers: { 'User-Agent': DESKTOP_UA, Origin: 'https://live.bilibili.com' },
    });
    entry.ws = ws;

    ws.on('open', () => {
      entry.retries = 0;
      this.notifyStatus(entry.slotIndex, 'connected', 'bilibili');
      recordDiagnostic(
        'info',
        'danmaku',
        `[槽位${entry.slotIndex + 1} bilibili#${realRid}] 弹幕已连接（${authUid ? `UID ${authUid}` : '游客模式'}）`
      );
      const auth = Buffer.from(
        JSON.stringify({
          uid: authUid,
          roomid: realRid,
          protover: 3,
          buvid: effectiveBuvid3,
          platform: 'web',
          type: 2,
          key: token,
        })
      );
      ws.send(pack(7, auth));
      ws.send(pack(2, Buffer.alloc(0)));
      entry.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pack(2, Buffer.alloc(0)));
      }, 30000);
    });

    ws.on('message', (data) => {
      unpack(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    ws.on('close', () => this.scheduleReconnect(entry));
    ws.on('error', () => {});
  }

  // ---------------- 3. Huya Tars WS ----------------
  private async connectHuya(entry: ActiveSlotDanmaku): Promise<void> {
    let numericRid = entry.roomId;
    if (!/^\d+$/.test(numericRid)) {
      const html = await fetchWithTimeout(
        `https://m.huya.com/${encodeURIComponent(numericRid)}`,
        { headers: { 'User-Agent': MOBILE_UA, Referer: 'https://m.huya.com/' } }
      ).then((r) => r.text());
      const m = html.match(/"lProfileRoom"\s*:\s*(\d+)/) || html.match(/"lp"\s*:\s*(\d+)/);
      if (m?.[1]) numericRid = m[1];
    }
    const profile = (await fetchWithTimeout(
      `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${encodeURIComponent(numericRid)}`,
      { headers: { 'User-Agent': MOBILE_UA, Referer: 'https://m.huya.com/' } }
    ).then((r) => r.json())) as {
      data?: { liveData?: { uid?: number | string }; profileInfo?: { uid?: number | string } };
    };
    if (entry.stopped) return;

    const ayyuid = profile?.data?.liveData?.uid || profile?.data?.profileInfo?.uid;
    if (!ayyuid) {
      throw new Error('未获取到虎牙主播 UID');
    }

    const ws = new WebSocket('wss://cdnws.api.huya.com/');
    entry.ws = ws;

    ws.on('open', () => {
      entry.retries = 0;
      this.notifyStatus(entry.slotIndex, 'connected', 'huya');
      recordDiagnostic('info', 'danmaku', `[槽位${entry.slotIndex + 1} huya#${numericRid}] 弹幕已连接`);
      const groupReq = Buffer.concat([
        tarsWriteList(0, [tarsWriteString(0, `live:${ayyuid}`), tarsWriteString(0, `chat:${ayyuid}`)]),
        tarsWriteString(1, ''),
      ]);
      ws.send(Buffer.concat([tarsWriteInt(0, 16), tarsWriteBytes(1, groupReq)]));
      entry.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.concat([tarsWriteInt(0, 1), tarsWriteBytes(1, Buffer.alloc(0))]));
        }
      }, 55000);
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      try {
        const cf = tarsReadFields(buf);
        const cmdType = Number(cf.get(0) ?? -1);
        const vData = cf.get(1);
        if ((cmdType === 7 || cmdType === 22) && Buffer.isBuffer(vData)) {
          const pf = tarsReadFields(vData);
          const uri = Number(pf.get(1) ?? 0);
          let payload = pf.get(2);
          const protocolType = Number(pf.get(4) ?? 0);
          if (uri === 1400 && Buffer.isBuffer(payload)) {
            if (protocolType === 1) {
              try {
                payload = zlib.inflateSync(payload);
              } catch {
                // Ignore
              }
            }
            const notice = tarsReadFields(payload);
            const userBuf = notice.get(0);
            const content = notice.get(3);
            const formatBuf = notice.get(6);
            let nick = '';
            if (Buffer.isBuffer(userBuf)) {
              try {
                nick = String(tarsReadFields(userBuf).get(2) || '');
              } catch {
                nick = '';
              }
            }
            let color: string | undefined;
            if (Buffer.isBuffer(formatBuf)) {
              try {
                const fontColor = Number(tarsReadFields(formatBuf).get(0) ?? -1);
                if (fontColor > 0 && fontColor !== 16777215) {
                  color = `#${fontColor.toString(16).padStart(6, '0')}`;
                }
              } catch {
                color = undefined;
              }
            }
            if (typeof content === 'string' && content && nick !== '系统消息') {
              this.enqueue(entry.slotIndex, 'huya', nick, content, color);
            }
          }
        }
      } catch {
        // Ignore malformed Tars frame
      }
    });

    ws.on('close', () => this.scheduleReconnect(entry));
    ws.on('error', () => {});
  }

  // ---------------- 4. Douyin Signed Protobuf WS ----------------
  private async connectDouyin(entry: ActiveSlotDanmaku): Promise<void> {
    const { ttwid } = await ensureDouyinSdkInfo();
    const ck = ttwid
      ? `${ttwid}; __ac_nonce=0123407cc00a9e438deb4`
      : '__ac_nonce=0123407cc00a9e438deb4';

    const enterUrl =
      'https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1' +
      '&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true' +
      '&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32' +
      `&browser_name=Edge&browser_version=136.0.0.0&web_rid=${encodeURIComponent(entry.roomId)}`;

    const enterText = await fetchWithTimeout(enterUrl, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: `https://live.douyin.com/${entry.roomId}`,
        Cookie: ck,
      },
    }).then((r) => r.text());
    if (entry.stopped) return;
    if (!enterText) throw new Error('抖音弹幕房间信息为空');

    const enterJson = JSON.parse(enterText) as {
      data?: { data?: Array<{ id_str?: string; status?: number }> };
    };
    const room = enterJson?.data?.data?.[0];
    if (!room?.id_str || room.status !== 2) {
      throw new Error('抖音直播间未开播或房间号无效');
    }

    const realRoomId = room.id_str;
    const userUniqueId = String(7319000000000000000n + BigInt(Math.floor(Math.random() * 999999999)));
    const { signature, ttwid: signedTtwid } = await signDouyinWsStub(realRoomId, userUniqueId);
    if (entry.stopped) return;
    if (!signature) throw new Error('抖音弹幕签名生成失败');

    const now = Date.now();
    const wssUrl =
      `wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/?app_name=douyin_web&version_code=180800` +
      `&webcast_sdk_version=1.0.14-beta.0&update_version_code=1.0.14-beta.0&compress=gzip&device_platform=web` +
      `&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32` +
      `&browser_name=Mozilla&browser_version=5.0&browser_online=true&tz_name=Asia/Shanghai` +
      `&cursor=t-${now}_r-1_d-1_u-1_fh-7392091211001140287` +
      `&internal_ext=internal_src:dim|wss_push_room_id:${realRoomId}|wss_push_did:${userUniqueId}|first_req_ms:${now}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0` +
      `&host=https://live.douyin.com&aid=6383&live_id=1&did_rule=3&endpoint=live_pc&support_wrds=1` +
      `&user_unique_id=${userUniqueId}&im_path=/webcast/im/fetch/&identity=audience&need_persist_msg_count=4` +
      `&insert_task_id=&live_reason=&room_id=${realRoomId}&heartbeatDuration=0&signature=${encodeURIComponent(signature)}`;

    const ws = new WebSocket(wssUrl, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Cookie: signedTtwid || ttwid,
        Origin: 'https://live.douyin.com',
      },
    });
    entry.ws = ws;

    ws.on('open', () => {
      entry.retries = 0;
      this.notifyStatus(entry.slotIndex, 'connected', 'douyin');
      recordDiagnostic('info', 'danmaku', `[槽位${entry.slotIndex + 1} douyin#${entry.roomId}] 弹幕已连接`);
      const hbFrame = encodeProtoBytes(7, Buffer.from('hb'));
      entry.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(hbFrame);
          } catch {
            // Ignore
          }
        }
      }, 10000);
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      try {
        const frameFields = parseProtoFields(buf);
        const logId = frameFields.find((f) => f.fieldNum === 2)?.val ?? 0n;
        const rawPayload = frameFields.find((f) => f.fieldNum === 8)?.buf;
        if (!rawPayload) return;

        let unzipped = rawPayload;
        try {
          unzipped = zlib.gunzipSync(rawPayload);
        } catch {
          // Payload may be uncompressed
        }

        const respFields = parseProtoFields(unzipped);
        const internalExt = respFields.find((f) => f.fieldNum === 5)?.buf;
        const needAck = respFields.find((f) => f.fieldNum === 9)?.val;
        if (needAck && needAck !== 0n && internalExt && ws.readyState === WebSocket.OPEN) {
          const ack = Buffer.concat([
            encodeProtoVarint(2, logId),
            encodeProtoBytes(7, Buffer.from('ack')),
            encodeProtoBytes(8, internalExt),
          ]);
          try {
            ws.send(ack);
          } catch {
            // Ignore
          }
        }

        for (const f of respFields) {
          if (f.fieldNum === 1 && f.buf) {
            const mf = parseProtoFields(f.buf);
            const method = mf.find((x) => x.fieldNum === 1)?.buf?.toString('utf-8') || '';
            const payload = mf.find((x) => x.fieldNum === 2)?.buf;
            if (method === 'WebcastChatMessage' && payload) {
              const cf = parseProtoFields(payload);
              const userBuf = cf.find((x) => x.fieldNum === 2)?.buf;
              const content = cf.find((x) => x.fieldNum === 3)?.buf?.toString('utf-8') || '';
              let nick = '';
              if (userBuf) {
                nick =
                  parseProtoFields(userBuf).find((x) => x.fieldNum === 3)?.buf?.toString('utf-8') ||
                  '';
              }
              if (content) {
                this.enqueue(entry.slotIndex, 'douyin', nick, content);
              }
            }
          }
        }
      } catch {
        // Ignore malformed Protobuf frame
      }
    });

    ws.on('close', () => this.scheduleReconnect(entry));
    ws.on('error', () => {});
  }
}
