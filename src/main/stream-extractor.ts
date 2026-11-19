import crypto from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { Session } from 'electron';
import type {
  DirectStreamRequest,
  DirectStreamResult,
  LiveRoomStatus,
  LiveStatusCheckItem,
  PlatformId,
  StreamOptionItem,
} from '../shared/types';
import { recordDiagnostic } from './diagnostics';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const HUYA_CDN_LABELS: Record<string, string> = {
  AL: '阿里主线',
  TX: '腾讯主线',
  HW: '华为线路',
  HS: '火山主线',
  WS: '网宿线路',
  AL13: '阿里备线',
  TX15: '腾讯备线',
  HS24: '火山备线',
  HY: '虎牙自建',
};

const DOUYIN_QUALITY_LABELS: Record<string, string> = {
  origin: '原画',
  ORIGIN: '原画',
  uhd: '蓝光超清',
  FULL_HD1: '蓝光',
  hd: '超清',
  HD1: '超清',
  sd: '高清',
  SD1: '高清',
  ld: '标清',
  SD2: '标清',
  md: '流畅',
  ao: '仅音频',
};

const DOUYIN_QUALITY_ORDER = ['origin', 'ORIGIN', 'FULL_HD1', 'uhd', 'HD1', 'hd', 'SD1', 'sd', 'SD2', 'ld', 'md'];

let cachedDouyinTtwid: { value: string; expiresAt: number } | null = null;
const huyaRidCache = new Map<string, string>();

function md5(input: string): string {
  return crypto.createHash('md5').update(String(input)).digest('hex');
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

async function getCookieHeaderForDomain(
  liveSession: Session,
  domain: string,
  allowNames?: Set<string>
): Promise<string> {
  try {
    const cookies = await liveSession.cookies.get({ domain });
    const filtered = allowNames ? cookies.filter((c) => allowNames.has(c.name)) : cookies;
    if (!filtered.length) return '';
    return filtered.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function fetchFreshAnonymousDouyinTtwid(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const resp = await fetch('https://live.douyin.com/', {
      method: 'HEAD',
      headers: { 'User-Agent': DESKTOP_UA },
      signal: controller.signal,
    });
    let setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    let ttwid =
      setCookies
        .map((c) => c.split(';')[0])
        .find((pair) => pair.startsWith('ttwid=')) || '';
    if (!ttwid) {
      const getResp = await fetch('https://live.douyin.com/', {
        headers: { 'User-Agent': DESKTOP_UA },
        signal: controller.signal,
      });
      setCookies = getResp.headers.getSetCookie ? getResp.headers.getSetCookie() : [];
      ttwid =
        setCookies
          .map((c) => c.split(';')[0])
          .find((pair) => pair.startsWith('ttwid=')) || '';
      void getResp.body?.cancel().catch(() => {});
    }
    if (ttwid) {
      cachedDouyinTtwid = { value: ttwid, expiresAt: Date.now() + 30 * 60 * 1000 };
    }
    return ttwid;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function getDouyinCookieHeader(forceRefresh = false): Promise<string> {
  // IMPORTANT: Never send logged-in Douyin sessionid / bd_ticket_guard_* cookies to web/enter,
  // otherwise Douyin's ticket-guard WAF rejects requests without signed client-data headers and returns empty body!
  // An anonymous ttwid + __ac_nonce unlocks full 1080p60 origin FLV/HLS streams cleanly.
  const now = Date.now();
  let ttwid =
    !forceRefresh && cachedDouyinTtwid && now < cachedDouyinTtwid.expiresAt
      ? cachedDouyinTtwid.value
      : '';
  if (!ttwid) {
    ttwid = await fetchFreshAnonymousDouyinTtwid();
  }
  return ttwid
    ? `${ttwid}; __ac_nonce=0123407cc00a9e438deb4`
    : '__ac_nonce=0123407cc00a9e438deb4';
}

function buildHuyaAntiCode(
  streamName: string,
  rawAntiCode: string,
  ratioBitrate?: string
): string {
  const params = new URLSearchParams(rawAntiCode.replace(/&amp;/g, '&'));
  const fmRaw = params.get('fm');
  const wsTime = Math.floor(Date.now() / 1000 + 21600).toString(16);
  const uid = String(1460000000000 + Math.floor(Math.random() * 99999999));
  const seqid = String(Number(uid) + Date.now());
  const ctype = params.get('ctype') || 'huya_live';
  const t = params.get('t') || '100';
  const fs = params.get('fs') || 'bgct';

  let wsSecret = params.get('wsSecret') || '';
  if (fmRaw) {
    const fm = Buffer.from(decodeURIComponent(fmRaw), 'base64').toString('utf-8');
    const prefix = fm.split('_')[0];
    const ss = md5(`${seqid}|${ctype}|${t}`);
    wsSecret = md5(`${prefix}_${uid}_${streamName}_${ss}_${wsTime}`);
  }

  const out = new URLSearchParams({
    wsSecret,
    wsTime,
    seqid,
    ctype,
    ver: '1',
    fs,
    u: uid,
    t,
    sv: '2401090219',
    sdk_sid: String(Date.now()),
    codec: '264',
  });
  if (ratioBitrate && ratioBitrate !== '0') {
    out.set('ratio', ratioBitrate);
  }
  return out.toString();
}

async function resolveHuyaNumericRid(roomId: string): Promise<string> {
  if (/^\d+$/.test(roomId)) return roomId;
  const cached = huyaRidCache.get(roomId);
  if (cached) return cached;

  const resp = await fetchWithTimeout(`https://m.huya.com/${encodeURIComponent(roomId)}`, {
    headers: { 'User-Agent': MOBILE_UA, Referer: 'https://m.huya.com/' },
  });
  const html = await resp.text();
  const match =
    html.match(/"lProfileRoom"\s*:\s*(\d+)/) ||
    html.match(/"lp"\s*:\s*(\d+)/) ||
    html.match(/lProfileRoom["']?\s*[:=]\s*["']?(\d+)/);
  if (match?.[1]) {
    huyaRidCache.set(roomId, match[1]);
    return match[1];
  }
  return roomId;
}

async function extractHuya(req: DirectStreamRequest): Promise<DirectStreamResult> {
  const referer = 'https://www.huya.com/';
  const numericRid = await resolveHuyaNumericRid(req.roomId);

  const resp = await fetchWithTimeout(
    `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${encodeURIComponent(numericRid)}`,
    {
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: 'https://m.huya.com/',
      },
    }
  );
  const json = (await resp.json()) as {
    status?: number;
    message?: string;
    data?: {
      liveStatus?: string;
      profileInfo?: { nick?: string };
      liveData?: { introduction?: string; nick?: string };
      stream?: {
        baseSteamInfoList?: Array<{
          sCdnType: string;
          sStreamName: string;
          sFlvUrl: string;
          sFlvUrlSuffix: string;
          sFlvAntiCode: string;
          sHlsUrl?: string;
          sHlsUrlSuffix?: string;
          sHlsAntiCode?: string;
        }>;
        flv?: {
          rateArray?: Array<{ iBitRate: number; sDisplayName: string }>;
        };
      };
    };
  };

  const data = json?.data;
  const title = data?.liveData?.introduction || data?.profileInfo?.nick;
  const anchorName = data?.profileInfo?.nick || data?.liveData?.nick;

  if (!data || data.liveStatus !== 'ON') {
    return {
      ok: false,
      platform: 'huya',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  const cdnList = data.stream?.baseSteamInfoList || [];
  if (cdnList.length === 0) {
    return {
      ok: false,
      platform: 'huya',
      roomId: req.roomId,
      status: 'error',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '未获取到虎牙直播流地址',
    };
  }

  const rateArray = data.stream?.flv?.rateArray || [];
  const rawQualities: Array<{ id: string; label: string }> = [{ id: '0', label: '原画' }];
  for (const r of rateArray) {
    const id = String(r.iBitRate);
    if (!rawQualities.some((q) => q.id === id)) {
      rawQualities.push({ id, label: r.sDisplayName || `${r.iBitRate}K` });
    }
  }

  const selectedQualityId =
    req.qualityId && rawQualities.some((q) => q.id === req.qualityId)
      ? req.qualityId
      : req.autoHighestQuality !== false
        ? rawQualities[0].id
        : (rawQualities[1]?.id ?? rawQualities[0].id);

  const selectedCdn =
    (req.lineId && cdnList.find((c) => c.sCdnType === req.lineId)) || cdnList[0];

  const flvAnti = buildHuyaAntiCode(
    selectedCdn.sStreamName,
    selectedCdn.sFlvAntiCode,
    selectedQualityId
  );
  const flvUrl = `${selectedCdn.sFlvUrl.replace(/^http:/, 'https:')}/${selectedCdn.sStreamName}.${selectedCdn.sFlvUrlSuffix}?${flvAnti}`;

  let hlsUrl: string | undefined;
  if (selectedCdn.sHlsUrl && selectedCdn.sHlsUrlSuffix && selectedCdn.sHlsAntiCode) {
    const hlsAnti = buildHuyaAntiCode(
      selectedCdn.sStreamName,
      selectedCdn.sHlsAntiCode,
      selectedQualityId
    );
    hlsUrl = `${selectedCdn.sHlsUrl.replace(/^http:/, 'https:')}/${selectedCdn.sStreamName}.${selectedCdn.sHlsUrlSuffix}?${hlsAnti}`;
  }

  const qualities: StreamOptionItem[] = rawQualities.map((q) => ({
    id: q.id,
    label: q.label,
    active: q.id === selectedQualityId,
  }));

  const seenCdns = new Set<string>();
  const lines: StreamOptionItem[] = [];
  for (const c of cdnList) {
    if (seenCdns.has(c.sCdnType)) continue;
    seenCdns.add(c.sCdnType);
    lines.push({
      id: c.sCdnType,
      label: HUYA_CDN_LABELS[c.sCdnType] || c.sCdnType,
      active: c.sCdnType === selectedCdn.sCdnType,
    });
  }

  return {
    ok: true,
    platform: 'huya',
    roomId: req.roomId,
    status: 'live',
    title,
    anchorName,
    flvUrl,
    hlsUrl,
    referer,
    qualities,
    lines,
  };
}

async function extractBilibili(
  req: DirectStreamRequest,
  liveSession: Session
): Promise<DirectStreamResult> {
  const referer = `https://live.bilibili.com/${req.roomId}`;
  const cookie = await getCookieHeaderForDomain(
    liveSession,
    'bilibili.com',
    new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'b_nut'])
  );
  const commonHeaders: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Referer: referer,
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const targetQn = req.qualityId || (req.autoHighestQuality !== false ? '10000' : '400');

  const [infoResp, playResp] = await Promise.all([
    fetchWithTimeout(
      `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${encodeURIComponent(req.roomId)}`,
      { headers: commonHeaders }
    )
      .then((r) => r.json())
      .catch(() => null),
    fetchWithTimeout(
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${encodeURIComponent(req.roomId)}&protocol=0,1&format=0,1,2&codec=0,1&qn=${encodeURIComponent(targetQn)}&platform=web&ptype=8&dolby=5&panorama=1`,
      { headers: commonHeaders }
    ).then((r) => r.json()),
  ]);

  const infoData = (infoResp as {
    data?: { room_info?: { title?: string; live_status?: number }; anchor_info?: { base_info?: { uname?: string } } };
  } | null)?.data;
  const playData = (playResp as {
    code?: number;
    data?: {
      live_status?: number;
      playurl_info?: {
        playurl?: {
          g_qn_desc?: Array<{ qn: number; desc: string }>;
          stream?: Array<{
            protocol_name: string;
            format: Array<{
              format_name: string;
              codec: Array<{
                codec_name: string;
                current_qn: number;
                accept_qn: number[];
                base_url: string;
                url_info: Array<{ host: string; extra: string }>;
              }>;
            }>;
          }>;
        };
      };
    };
  })?.data;

  const title = infoData?.room_info?.title;
  const anchorName = infoData?.anchor_info?.base_info?.uname;
  const liveStatus = playData?.live_status ?? infoData?.room_info?.live_status;

  if (!playData || liveStatus !== 1) {
    return {
      ok: false,
      platform: 'bilibili',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  const playurl = playData.playurl_info?.playurl;
  const descMap = new Map<number, string>();
  for (const item of playurl?.g_qn_desc || []) {
    descMap.set(item.qn, item.desc);
  }

  type CodecEntry = {
    formatName: string;
    codecName: string;
    currentQn: number;
    acceptQn: number[];
    urls: string[];
  };
  const flvEntries: CodecEntry[] = [];
  const hlsEntries: CodecEntry[] = [];

  for (const st of playurl?.stream || []) {
    for (const fmt of st.format || []) {
      for (const cd of fmt.codec || []) {
        const sortedUrls = [...(cd.url_info || [])]
          .sort((a, b) => {
            const aMcdn = a.host.includes('mcdn') ? 1 : 0;
            const bMcdn = b.host.includes('mcdn') ? 1 : 0;
            return aMcdn - bMcdn;
          })
          .map((u) => `${u.host}${cd.base_url}${u.extra}`);
        if (sortedUrls.length === 0) continue;
        const entry: CodecEntry = {
          formatName: fmt.format_name,
          codecName: cd.codec_name,
          currentQn: cd.current_qn,
          acceptQn: cd.accept_qn || [],
          urls: sortedUrls,
        };
        if (fmt.format_name === 'flv') flvEntries.push(entry);
        else hlsEntries.push(entry);
      }
    }
  }

  // Prefer AVC (H.264) for maximum Chromium MSE compatibility
  const pickCodec = (entries: CodecEntry[]) =>
    entries.find((e) => e.codecName === 'avc') || entries[0];
  const flvCodec = pickCodec(flvEntries);
  const hlsCodec = pickCodec(hlsEntries);
  const primary = flvCodec || hlsCodec;

  if (!primary) {
    return {
      ok: false,
      platform: 'bilibili',
      roomId: req.roomId,
      status: 'error',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '未获取到 B站可用直播流',
    };
  }

  const maxLines = Math.max(flvCodec?.urls.length || 0, hlsCodec?.urls.length || 0);
  const lineIdx = Math.min(
    Math.max(0, Number.parseInt(req.lineId || '0', 10) || 0),
    Math.max(0, maxLines - 1)
  );

  const flvUrl = flvCodec?.urls[Math.min(lineIdx, flvCodec.urls.length - 1)];
  const hlsUrl = hlsCodec?.urls[Math.min(lineIdx, hlsCodec.urls.length - 1)];

  const qualities: StreamOptionItem[] = primary.acceptQn.map((qn) => ({
    id: String(qn),
    label: descMap.get(qn) || `${qn}P`,
    active: qn === primary.currentQn,
  }));

  const lines: StreamOptionItem[] = Array.from({ length: maxLines }, (_, i) => {
    const sampleUrl = flvCodec?.urls[i] || hlsCodec?.urls[i] || '';
    const isMcdn = sampleUrl.includes('mcdn');
    return {
      id: String(i),
      label: isMcdn ? `备线 ${i + 1}` : `主线 ${i + 1}`,
      active: i === lineIdx,
    };
  });

  return {
    ok: true,
    platform: 'bilibili',
    roomId: req.roomId,
    status: 'live',
    title,
    anchorName,
    flvUrl,
    hlsUrl,
    referer,
    qualities,
    lines,
  };
}

// Isolated sandboxed hidden renderer for Douyu ub98484234 signing (no Node access, idle auto-cleanup)
let douyuSignerWin: BrowserWindow | null = null;
let douyuSignerReady: Promise<BrowserWindow> | null = null;
let douyuSignerIdleTimer: NodeJS.Timeout | null = null;

const PURE_JS_MD5_SOURCE = `
function __md5(str) {
  const bytes = new TextEncoder().encode(String(str));
  const len = bytes.length;
  const words = [];
  for (let i = 0; i < len; i++) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  }
  words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8));
  const totalWords = (((len + 8) >> 6) + 1) * 16;
  while (words.length < totalWords) words.push(0);
  words[totalWords - 2] = (len * 8) >>> 0;
  words[totalWords - 1] = Math.floor((len * 8) / 0x100000000) >>> 0;

  const K = [
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
  ];
  const S = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
  ];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < words.length; i += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F, g;
      if (j < 16) { F = (B & C) | ((~B) & D); g = j; }
      else if (j < 32) { F = (D & B) | ((~D) & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | (~D)); g = (7 * j) % 16; }
      const sum = (A + F + K[j] + (words[i + g] >>> 0)) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((sum << S[j]) | (sum >>> (32 - S[j])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const toHex = (n) => {
    let out = '';
    for (let k = 0; k < 4; k++) out += ((n >>> (k * 8)) & 0xff).toString(16).padStart(2, '0');
    return out;
  };
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}
window.CryptoJS = { MD5: (s) => ({ toString: () => __md5(s) }) };
true;
`;

function touchDouyuSignerIdle(): void {
  if (douyuSignerIdleTimer) clearTimeout(douyuSignerIdleTimer);
  douyuSignerIdleTimer = setTimeout(() => {
    douyuSignerIdleTimer = null;
    if (douyuSignerWin && !douyuSignerWin.isDestroyed()) {
      try {
        douyuSignerWin.destroy();
      } catch {
        // Ignore
      }
      douyuSignerWin = null;
    }
  }, 90_000);
}

export function cleanupStreamExtractor(): void {
  if (douyuSignerIdleTimer) {
    clearTimeout(douyuSignerIdleTimer);
    douyuSignerIdleTimer = null;
  }
  if (douyuSignerWin && !douyuSignerWin.isDestroyed()) {
    try {
      douyuSignerWin.destroy();
    } catch {
      // Ignore
    }
    douyuSignerWin = null;
  }
}

async function getDouyuSignerWindow(): Promise<BrowserWindow> {
  if (douyuSignerWin && !douyuSignerWin.isDestroyed()) {
    touchDouyuSignerIdle();
    return douyuSignerWin;
  }
  if (douyuSignerReady) return douyuSignerReady;

  douyuSignerReady = (async () => {
    const win = new BrowserWindow({
      width: 64,
      height: 64,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: false,
      },
    });
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><html><body></body></html>');
    await win.webContents.executeJavaScript(PURE_JS_MD5_SOURCE);
    win.on('closed', () => {
      if (douyuSignerWin === win) douyuSignerWin = null;
    });
    douyuSignerWin = win;
    touchDouyuSignerIdle();
    return win;
  })().finally(() => {
    douyuSignerReady = null;
  });

  return douyuSignerReady;
}

async function runDouyuSignInSandbox(
  jsCode: string,
  rid: string,
  did: string,
  tt: number
): Promise<string> {
  const win = await getDouyuSignerWindow();
  touchDouyuSignerIdle();
  // Execute at global scope (not inside an IIFE) because Douyu's obfuscated script
  // declares top-level globals (e.g. vdwdae325w_64we) referenced via eval/window.
  const script = `${jsCode};\nString(ub98484234(${JSON.stringify(rid)}, ${JSON.stringify(did)}, ${tt}));`;
  const result = await Promise.race<string>([
    win.webContents.executeJavaScript(script) as Promise<string>,
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('斗鱼签名执行超时')), 3000)
    ),
  ]);
  return String(result || '');
}

async function extractDouyu(
  req: DirectStreamRequest,
  liveSession: Session
): Promise<DirectStreamResult> {
  const referer = `https://www.douyu.com/${req.roomId}`;
  const douyuCookies = await liveSession.cookies.get({ domain: 'douyu.com' }).catch(() => []);
  const allowSet = new Set(['acf_auth', 'acf_uid', 'acf_username', 'dy_did']);
  const filteredCookies = douyuCookies.filter((c) => allowSet.has(c.name));
  const cookie = filteredCookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const cookieDid = douyuCookies.find((c) => c.name === 'dy_did' && c.value)?.value;
  const commonHeaders: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Referer: referer,
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const betard = (await fetchWithTimeout(
    `https://www.douyu.com/betard/${encodeURIComponent(req.roomId)}`,
    { headers: commonHeaders }
  )
    .then((r) => r.json())
    .catch(() => null)) as {
    room?: {
      room_id?: number;
      room_name?: string;
      nickname?: string;
      show_status?: number;
      videoLoop?: number;
    };
  } | null;

  const rid = String(betard?.room?.room_id || req.roomId);
  const title = betard?.room?.room_name;
  const anchorName = betard?.room?.nickname;

  if (betard?.room && betard.room.show_status !== 1) {
    return {
      ok: false,
      platform: 'douyu',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  const encRes = (await fetchWithTimeout(
    `https://www.douyu.com/swf_api/homeH5Enc?rids=${encodeURIComponent(rid)}`,
    { headers: commonHeaders }
  ).then((r) => r.json())) as { data?: Record<string, string> };

  const jsCode = encRes?.data?.[`room${rid}`];
  if (!jsCode) {
    return {
      ok: false,
      platform: 'douyu',
      roomId: req.roomId,
      status: 'error',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '未获取到斗鱼签名脚本',
    };
  }

  const did = cookieDid || '10000000000000000000000000001501';
  const tt = Math.floor(Date.now() / 1000);
  const signQuery = await runDouyuSignInSandbox(jsCode, rid, did, tt);

  const targetRate = req.qualityId ?? (req.autoHighestQuality !== false ? '0' : '2');
  const targetCdn = req.lineId || '';
  const body = `${signQuery}&cdn=${encodeURIComponent(targetCdn)}&rate=${encodeURIComponent(targetRate)}&ver=Douyu_223061205&iar=0&ive=0&hevc=0&fa=0`;

  const playRes = (await fetchWithTimeout(`https://www.douyu.com/lapi/live/getH5Play/${rid}`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }).then((r) => r.json())) as {
    error?: number;
    msg?: string;
    data?: {
      rtmp_url?: string;
      rtmp_live?: string;
      rtmp_cdn?: string;
      rate?: number;
      multirates?: Array<{ name: string; rate: number }>;
      cdnsWithName?: Array<{ name: string; cdn: string }>;
    };
  };

  if (playRes?.error !== 0 || !playRes.data?.rtmp_url || !playRes.data?.rtmp_live) {
    const isOffline = playRes?.error === -5;
    return {
      ok: false,
      platform: 'douyu',
      roomId: req.roomId,
      status: isOffline ? 'offline' : 'error',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: playRes?.msg || '获取斗鱼直播流失败',
    };
  }

  const d = playRes.data;
  const flvUrl = `${d.rtmp_url}/${d.rtmp_live}`;

  const qualities: StreamOptionItem[] = (d.multirates || []).map((m) => ({
    id: String(m.rate),
    label: m.name,
    active: m.rate === d.rate,
  }));

  const lines: StreamOptionItem[] = (d.cdnsWithName || []).map((c) => ({
    id: c.cdn,
    label: c.name || c.cdn,
    active: c.cdn === d.rtmp_cdn,
  }));

  return {
    ok: true,
    platform: 'douyu',
    roomId: req.roomId,
    status: 'live',
    title,
    anchorName,
    flvUrl,
    referer,
    qualities,
    lines,
  };
}

async function extractDouyin(req: DirectStreamRequest): Promise<DirectStreamResult> {
  const referer = `https://live.douyin.com/${req.roomId}`;
  const apiUrl =
    'https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1' +
    '&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true' +
    '&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32' +
    `&browser_name=Edge&browser_version=136.0.0.0&web_rid=${encodeURIComponent(req.roomId)}`;

  const fetchEnterText = async (forceRefresh: boolean) => {
    const cookieHeader = await getDouyinCookieHeader(forceRefresh);
    const resp = await fetchWithTimeout(apiUrl, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: referer,
        Cookie: cookieHeader,
      },
    });
    return resp.text();
  };

  let text = await fetchEnterText(false);
  if (!text) {
    text = await fetchEnterText(true);
  }
  if (!text) {
    return {
      ok: false,
      platform: 'douyin',
      roomId: req.roomId,
      status: 'error',
      referer,
      qualities: [],
      lines: [],
      error: '抖音接口返回空响应，可重试或切网页模式',
    };
  }

  const json = JSON.parse(text) as {
    status_code?: number;
    data?: {
      user?: { nickname?: string };
      data?: Array<{
        status?: number;
        title?: string;
        stream_url?: {
          flv_pull_url?: Record<string, string>;
          hls_pull_url_map?: Record<string, string>;
          live_core_sdk_data?: {
            pull_data?: {
              stream_data?: string;
            };
          };
        };
      }>;
    };
  };

  const room = json?.data?.data?.[0];
  const title = room?.title;
  const anchorName = json?.data?.user?.nickname;

  if (!room || room.status !== 2) {
    return {
      ok: false,
      platform: 'douyin',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  // Prefer live_core_sdk_data (which includes true 'origin' stream); fall back to flv_pull_url / hls_pull_url_map
  const flvMap = new Map<string, string>();
  const hlsMap = new Map<string, string>();

  const sdkRaw = room.stream_url?.live_core_sdk_data?.pull_data?.stream_data;
  if (sdkRaw) {
    try {
      const parsed = JSON.parse(sdkRaw) as {
        data?: Record<string, { main?: { flv?: string; hls?: string } }>;
      };
      for (const [key, val] of Object.entries(parsed.data || {})) {
        if (key === 'ao') continue;
        if (val?.main?.flv) flvMap.set(key, val.main.flv);
        if (val?.main?.hls) hlsMap.set(key, val.main.hls);
      }
    } catch {
      // Ignore malformed SDK stream_data
    }
  }

  if (flvMap.size === 0 && hlsMap.size === 0) {
    for (const [k, v] of Object.entries(room.stream_url?.flv_pull_url || {})) {
      if (v) flvMap.set(k, v);
    }
    for (const [k, v] of Object.entries(room.stream_url?.hls_pull_url_map || {})) {
      if (v) hlsMap.set(k, v);
    }
  }

  const allKeys = Array.from(new Set([...flvMap.keys(), ...hlsMap.keys()])).sort((a, b) => {
    const ia = DOUYIN_QUALITY_ORDER.indexOf(a);
    const ib = DOUYIN_QUALITY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  if (allKeys.length === 0) {
    return {
      ok: false,
      platform: 'douyin',
      roomId: req.roomId,
      status: 'error',
      title,
      anchorName,
      referer,
      qualities: [],
      lines: [],
      error: '未解析到抖音可用清晰度流',
    };
  }

  const selectedKey =
    req.qualityId && allKeys.includes(req.qualityId)
      ? req.qualityId
      : req.autoHighestQuality !== false
        ? allKeys[0]
        : (allKeys[1] ?? allKeys[0]);

  const rawFlv = flvMap.get(selectedKey);
  const rawHls = hlsMap.get(selectedKey);
  const preferHls = req.lineId === 'hls';

  const qualities: StreamOptionItem[] = allKeys.map((k) => ({
    id: k,
    label: DOUYIN_QUALITY_LABELS[k] || k,
    active: k === selectedKey,
  }));

  const lines: StreamOptionItem[] = [];
  if (rawFlv) {
    lines.push({ id: 'flv', label: '极速 FLV', active: !preferHls });
  }
  if (rawHls) {
    lines.push({ id: 'hls', label: '稳定 HLS', active: preferHls || !rawFlv });
  }

  return {
    ok: true,
    platform: 'douyin',
    roomId: req.roomId,
    status: 'live',
    title,
    anchorName,
    flvUrl: preferHls ? undefined : rawFlv,
    hlsUrl: rawHls,
    referer: 'https://live.douyin.com/',
    qualities,
    lines,
  };
}

export async function resolveDirectStream(
  req: DirectStreamRequest,
  liveSession: Session
): Promise<DirectStreamResult> {
  const defaultReferers: Record<PlatformId, string> = {
    huya: 'https://www.huya.com/',
    douyu: 'https://www.douyu.com/',
    bilibili: 'https://live.bilibili.com/',
    douyin: 'https://live.douyin.com/',
  };

  try {
    let result: DirectStreamResult;
    switch (req.platform) {
      case 'huya':
        result = await extractHuya(req);
        break;
      case 'bilibili':
        result = await extractBilibili(req, liveSession);
        break;
      case 'douyu':
        result = await extractDouyu(req, liveSession);
        break;
      case 'douyin':
        result = await extractDouyin(req);
        break;
      default:
        result = {
          ok: false,
          platform: req.platform,
          roomId: req.roomId,
          status: 'error',
          referer: defaultReferers[req.platform] || '',
          qualities: [],
          lines: [],
          error: '暂不支持该平台直连抓流',
        };
        break;
    }
    if (result.ok) {
      const activeQ = result.qualities.find((q) => q.active)?.label || '默认';
      const activeL = result.lines.find((l) => l.active)?.label || '默认';
      recordDiagnostic(
        'info',
        'stream',
        `[${req.platform}#${req.roomId}] 抓流成功（画质:${activeQ} / 线路:${activeL}）`
      );
    } else if (result.status === 'error') {
      recordDiagnostic(
        'warn',
        'stream',
        `[${req.platform}#${req.roomId}] 抓流失败：${result.error || '未知原因'}`
      );
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : '抓流请求超时或网络异常';
    recordDiagnostic('error', 'stream', `[${req.platform}#${req.roomId}] 抓流异常：${msg}`);
    return {
      ok: false,
      platform: req.platform,
      roomId: req.roomId,
      status: 'error',
      referer: defaultReferers[req.platform] || '',
      qualities: [],
      lines: [],
      error: msg,
    };
  }
}

async function checkSingleLiveStatus(item: LiveStatusCheckItem): Promise<LiveRoomStatus> {
  const checkedAt = Date.now();
  try {
    switch (item.platform) {
      case 'huya': {
        const numericRid = await resolveHuyaNumericRid(item.roomId);
        const resp = await fetchWithTimeout(
          `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${encodeURIComponent(numericRid)}`,
          {
            headers: {
              'User-Agent': MOBILE_UA,
              Referer: 'https://m.huya.com/',
            },
          },
          8500
        );
        const json = (await resp.json()) as {
          data?: {
            liveStatus?: string;
            realLiveStatus?: string;
            profileInfo?: { nick?: string };
            liveData?: { introduction?: string; nick?: string };
          };
        };
        const d = json?.data;
        if (!d) return { status: 'unknown', checkedAt };
        const rawState = String(d.liveStatus || d.realLiveStatus || '').toUpperCase();
        const status =
          rawState === 'ON' ? 'live' : rawState === 'REPLAY' ? 'replay' : 'offline';
        return {
          status,
          anchorName: d.profileInfo?.nick || d.liveData?.nick,
          title: d.liveData?.introduction,
          checkedAt,
        };
      }

      case 'douyu': {
        const resp = await fetchWithTimeout(
          `https://www.douyu.com/betard/${encodeURIComponent(item.roomId)}`,
          {
            headers: {
              'User-Agent': DESKTOP_UA,
              Referer: `https://www.douyu.com/${item.roomId}`,
            },
          },
          5500
        );
        const json = (await resp.json()) as {
          room?: {
            show_status?: number;
            videoLoop?: number;
            room_name?: string;
            nickname?: string;
          };
        };
        const room = json?.room;
        if (!room) return { status: 'unknown', checkedAt };
        const status =
          room.show_status === 1
            ? room.videoLoop === 1
              ? 'replay'
              : 'live'
            : 'offline';
        return {
          status,
          anchorName: room.nickname,
          title: room.room_name,
          checkedAt,
        };
      }

      case 'bilibili': {
        const resp = await fetchWithTimeout(
          `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(item.roomId)}`,
          {
            headers: {
              'User-Agent': DESKTOP_UA,
              Referer: `https://live.bilibili.com/${item.roomId}`,
            },
          },
          7000
        );
        const json = (await resp.json()) as {
          code?: number;
          data?: {
            live_status?: number;
            title?: string;
          };
        };
        const info = json?.data;
        if (json?.code !== 0 || !info) return { status: 'unknown', checkedAt };
        const status =
          info.live_status === 1 ? 'live' : info.live_status === 2 ? 'replay' : 'offline';
        return {
          status,
          title: info.title,
          checkedAt,
        };
      }

      case 'douyin': {
        const enterUrl =
          `https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1` +
          `&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true` +
          `&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32` +
          `&browser_name=Edge&browser_version=136.0.0.0&web_rid=${encodeURIComponent(item.roomId)}`;

        const queryEnter = async (forceRefreshCookie: boolean) => {
          const cookieHeader = await getDouyinCookieHeader(forceRefreshCookie);
          const resp = await fetchWithTimeout(
            enterUrl,
            {
              headers: {
                'User-Agent': DESKTOP_UA,
                Referer: `https://live.douyin.com/${item.roomId}`,
                Accept: 'application/json, text/plain, */*',
                Cookie: cookieHeader,
              },
            },
            5500
          );
          const text = await resp.text();
          if (!text.trim()) return null;
          return JSON.parse(text) as {
            data?: {
              data?: Array<{
                status?: number;
                title?: string;
                owner?: { nickname?: string };
              }>;
              user?: { nickname?: string };
            };
          };
        };

        let parsed = await queryEnter(false).catch(() => null);
        if (!parsed) {
          parsed = await queryEnter(true).catch(() => null);
        }
        if (!parsed?.data) return { status: 'unknown', checkedAt };
        const room = parsed.data.data?.[0];
        const status = room?.status === 2 ? 'live' : 'offline';
        return {
          status,
          anchorName: parsed.data.user?.nickname || room?.owner?.nickname,
          title: room?.title,
          checkedAt,
        };
      }

      default:
        return { status: 'unknown', checkedAt };
    }
  } catch {
    return { status: 'unknown', checkedAt };
  }
}

export async function checkLiveStatuses(
  items: LiveStatusCheckItem[]
): Promise<Record<string, LiveRoomStatus>> {
  const results: Record<string, LiveRoomStatus> = {};
  if (!Array.isArray(items) || items.length === 0) return results;

  // Warm anonymous Douyin ttwid once upfront if any Douyin channels are queued
  if (items.some((i) => i.platform === 'douyin')) {
    await getDouyinCookieHeader(false).catch(() => '');
  }

  const concurrency = 6;
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (!item) break;
      results[item.id] = await checkSingleLiveStatus(item);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}
