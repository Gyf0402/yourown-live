import crypto from 'node:crypto';
import vm from 'node:vm';
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
  origin_60: '原画 60帧',
  origin: '原画',
  ORIGIN: '原画',
  uhd_60: '蓝光 60帧',
  uhd: '蓝光超清',
  FULL_HD1: '蓝光',
  full_hd1: '蓝光',
  hd_60: '超清 60帧',
  hd: '超清',
  HD1: '超清',
  sd: '高清',
  SD1: '高清',
  sd1: '高清',
  ld: '标清',
  SD2: '标清',
  sd2: '标清',
  md: '流畅',
  ao: '仅音频',
};

const DOUYIN_QUALITY_ORDER = [
  'origin_60',
  'origin',
  'ORIGIN',
  'uhd_60',
  'FULL_HD1',
  'full_hd1',
  'uhd',
  'hd_60',
  'HD1',
  'hd',
  'SD1',
  'sd1',
  'sd',
  'SD2',
  'sd2',
  'ld',
  'md',
];

let cachedDouyinTtwid: { value: string; expiresAt: number } | null = null;
const huyaRidCache = new Map<string, string>();
const douyuRidCache = new Map<string, string>();

interface DouyuBetardRoom {
  room_id?: number;
  room_name?: string;
  nickname?: string;
  show_status?: number;
  videoLoop?: number;
  second_lvl_name?: string;
  cate_name?: string;
}

async function fetchDouyuBetard(
  rid: string,
  extraHeaders: Record<string, string> = {},
  liveSession?: Session
): Promise<DouyuBetardRoom | null> {
  try {
    const url = `https://www.douyu.com/betard/${encodeURIComponent(rid)}`;
    const resp = liveSession
      ? await sessionFetchWithTimeout(liveSession, url, 5500)
      : await fetchWithTimeout(
          url,
          {
            headers: {
              'User-Agent': DESKTOP_UA,
              Referer: `https://www.douyu.com/${rid}`,
              ...extraHeaders,
            },
          },
          5500
        );
    const text = await resp.text();
    if (!text.trim().startsWith('{')) return null;
    const json = JSON.parse(text) as { room?: DouyuBetardRoom; game?: { tag_name?: string } };
    if (!json?.room?.room_id) return null;
    if (!json.room.second_lvl_name && json.game?.tag_name) {
      json.room.second_lvl_name = json.game.tag_name;
    }
    return json.room;
  } catch {
    return null;
  }
}

export async function resolveDouyuRealRid(rawRoomId: string): Promise<{
  rid: string;
  room?: DouyuBetardRoom | null;
}> {
  const clean = rawRoomId.trim();
  const cached = douyuRidCache.get(clean);
  if (cached) {
    const room = await fetchDouyuBetard(cached);
    return { rid: cached, room };
  }

  // 1. Try betard directly (works for standard numeric room IDs like 9999, 288016)
  const directRoom = await fetchDouyuBetard(clean);
  if (directRoom?.room_id) {
    const realRid = String(directRoom.room_id);
    douyuRidCache.set(clean, realRid);
    return { rid: realRid, room: directRoom };
  }

  // 2. Fallback to m.douyu.com/{id} — resolves vanity short IDs (e.g. 728 -> 12821, 2222 -> 4615502) & slugs
  try {
    const mResp = await fetchWithTimeout(
      `https://m.douyu.com/${encodeURIComponent(clean)}`,
      {
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: 'https://m.douyu.com/',
        },
      },
      6500
    );
    const html = await mResp.text();
    const match =
      html.match(/"rid"\s*:\s*(\d+)/) ||
      html.match(/room_id["']?\s*[:=]\s*["']?(\d+)/);
    if (match?.[1]) {
      const realRid = match[1];
      douyuRidCache.set(clean, realRid);
      const room = await fetchDouyuBetard(realRid);
      return { rid: realRid, room };
    }
  } catch {
    // Ignore mobile page lookup errors
  }

  return { rid: clean, room: null };
}

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
    let fmDecoded = fmRaw;
    try {
      fmDecoded = decodeURIComponent(fmRaw);
    } catch {
      fmDecoded = fmRaw;
    }
    const fm = Buffer.from(fmDecoded, 'base64').toString('utf-8');
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
      liveData?: { introduction?: string; nick?: string; gameFullName?: string };
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
  const category = data?.liveData?.gameFullName?.trim() || undefined;

  if (!data || data.liveStatus !== 'ON') {
    return {
      ok: false,
      platform: 'huya',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      category,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  const cdnList = (data.stream?.baseSteamInfoList || []).filter(
    (c) => Boolean(c.sFlvUrl || c.sHlsUrl)
  );
  if (cdnList.length === 0) {
    return {
      ok: false,
      platform: 'huya',
      roomId: req.roomId,
      status: 'error',
      title,
      anchorName,
      category,
      referer,
      qualities: [],
      lines: [],
      error: '未获取到虎牙直播流地址',
    };
  }

  const rateArray = data.stream?.flv?.rateArray || [];
  const zeroRate = rateArray.find((r) => r.iBitRate === 0);
  const rawQualities: Array<{ id: string; label: string }> = [
    { id: '0', label: zeroRate?.sDisplayName || '原画' },
  ];
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
    category,
    flvUrl,
    hlsUrl,
    referer,
    qualities,
    lines,
  };
}

function scoreBilibiliHost(host: string): number {
  const h = host.toLowerCase();
  if (h.includes('mcdn') || h.includes('pcdn')) return 4;
  if (h.includes('gotcha101') || h.includes('ov-gotcha')) return 3;
  // Commercial gotcha CDNs (Tencent/Aliyun/etc. like gotcha04b/gotcha208/gotcha209) have much lower TTFB than cn-*-fx-*
  if (h.includes('gotcha')) return 0;
  return 1;
}

function labelBilibiliUrl(url: string, idx: number): string {
  const lower = url.toLowerCase();
  if (lower.includes('mcdn') || lower.includes('pcdn')) return `备线 ${idx + 1}`;
  if (lower.includes('gotcha101') || lower.includes('ov-gotcha')) return `备用 ${idx + 1}`;
  if (lower.includes('gotcha')) return `高速主线 ${idx + 1}`;
  return `主线 ${idx + 1}`;
}

let cachedFastBiliHost: { host: string; expiresAt: number } | null = null;

async function raceFastestBilibiliUrl(
  urls: string[],
  headers: Record<string, string>
): Promise<{ index: number; finalUrl: string; ms: number } | null> {
  if (urls.length <= 1) return null;

  // Reuse recently-verified fast CDN host (5 min TTL) to avoid redundant 4-way GET首包 bandwidth
  const now = Date.now();
  if (cachedFastBiliHost && now < cachedFastBiliHost.expiresAt) {
    const cachedIdx = urls.findIndex((u) => {
      try {
        return new URL(u).hostname.toLowerCase() === cachedFastBiliHost!.host;
      } catch {
        return false;
      }
    });
    if (cachedIdx >= 0) {
      return { index: cachedIdx, finalUrl: urls[cachedIdx], ms: 0 };
    }
  }

  const maxProbe = Math.min(urls.length, 3);
  const controllers: AbortController[] = [];
  const startedAt = Date.now();
  const hardTimeout = setTimeout(() => {
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        // Ignore
      }
    }
  }, 1500);

  const probes = urls.slice(0, maxProbe).map((url, idx) => {
    const ac = new AbortController();
    controllers.push(ac);
    return fetch(url, { headers, redirect: 'follow', signal: ac.signal }).then((resp) => {
      void resp.body?.cancel().catch(() => {});
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return { index: idx, finalUrl: resp.url || url, ms: Date.now() - startedAt };
    });
  });

  try {
    const winner = await Promise.any(probes);
    if (winner.ms <= 800) {
      try {
        const winHost = new URL(urls[winner.index]).hostname.toLowerCase();
        if (winHost) {
          cachedFastBiliHost = { host: winHost, expiresAt: Date.now() + 5 * 60 * 1000 };
        }
      } catch {
        // Ignore malformed host
      }
    }
    return winner;
  } catch {
    return null;
  } finally {
    clearTimeout(hardTimeout);
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        // Ignore
      }
    }
  }
}

const bilibiliAnchorCache = new Map<number, string>();
const bilibiliRealRidCache = new Map<string, { realRid: string; uid?: number }>();
const BILI_WBI_MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
let cachedBiliWbiKeys: { imgKey: string; subKey: string; expiresAt: number } | null = null;
let lastBiliWarmAt = 0;

async function sessionFetchWithTimeout(
  liveSession: Session,
  url: string,
  timeoutMs = 5500,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await liveSession.fetch(url, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function resolveBilibiliCategory(info?: {
  area_name?: string;
  parent_area_name?: string;
  tags?: string;
}): string | undefined {
  if (!info) return undefined;
  const area = (info.area_name || '').trim();
  const parent = (info.parent_area_name || '').trim();
  const tags = (info.tags || '').trim();
  if (tags && (!area || /赛事|综合|其他/.test(area))) {
    const firstGameTag = tags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .find((t) => /^(英雄联盟|lol|王者荣耀|dota2?|cs2|csgo|无畏契约|绝地求生|apex|原神|三角洲)$/i.test(t));
    if (firstGameTag) return firstGameTag;
  }
  return area || parent || undefined;
}

async function getBilibiliWbiKeys(
  liveSession: Session
): Promise<{ imgKey: string; subKey: string } | null> {
  const now = Date.now();
  if (cachedBiliWbiKeys && now < cachedBiliWbiKeys.expiresAt) {
    return { imgKey: cachedBiliWbiKeys.imgKey, subKey: cachedBiliWbiKeys.subKey };
  }
  try {
    const resp = await sessionFetchWithTimeout(
      liveSession,
      'https://api.bilibili.com/x/web-interface/nav',
      2200
    );
    const json = (await resp.json()) as {
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    };
    const imgKey = (json?.data?.wbi_img?.img_url || '').split('/').pop()?.split('.')[0] || '';
    const subKey = (json?.data?.wbi_img?.sub_url || '').split('/').pop()?.split('.')[0] || '';
    if (imgKey && subKey) {
      cachedBiliWbiKeys = { imgKey, subKey, expiresAt: now + 30 * 60 * 1000 };
      return { imgKey, subKey };
    }
  } catch {
    // Non-fatal
  }
  return null;
}

function buildBilibiliWbiQuery(
  params: Record<string, string | number>,
  wbi: { imgKey: string; subKey: string } | null
): string {
  if (!wbi) {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
  }
  const raw = wbi.imgKey + wbi.subKey;
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

async function ensureBilibiliLiveCookies(liveSession: Session): Promise<boolean> {
  try {
    const cookies = await liveSession.cookies.get({ domain: 'bilibili.com' });
    const hasSessdata = cookies.some((c) => c.name === 'SESSDATA' && Boolean(c.value));
    const hasBuvid3 = cookies.some((c) => c.name === 'buvid3' && Boolean(c.value));
    const hasLiveBuvid = cookies.some((c) => c.name === 'LIVE_BUVID' && Boolean(c.value));

    // After QR login on passport.bilibili.com, LIVE_BUVID / buvid3 may not exist yet;
    // warming live.bilibili.com once lets Bilibili mint full live session cookies natively.
    if (hasSessdata && (!hasBuvid3 || !hasLiveBuvid) && Date.now() - lastBiliWarmAt > 30_000) {
      lastBiliWarmAt = Date.now();
      await Promise.allSettled([
        sessionFetchWithTimeout(liveSession, 'https://api.bilibili.com/x/frontend/finger/spi', 1400)
          .then((r) => r.json())
          .then(async (j: { data?: { b_3?: string; b_4?: string } }) => {
            if (!hasBuvid3 && j?.data?.b_3) {
              await liveSession.cookies.set({
                url: 'https://www.bilibili.com',
                name: 'buvid3',
                value: j.data.b_3,
                domain: '.bilibili.com',
                path: '/',
              });
            }
            if (j?.data?.b_4) {
              await liveSession.cookies.set({
                url: 'https://www.bilibili.com',
                name: 'buvid4',
                value: j.data.b_4,
                domain: '.bilibili.com',
                path: '/',
              });
            }
          }),
        sessionFetchWithTimeout(liveSession, 'https://live.bilibili.com/', 1500).then((r) =>
          r.body?.cancel().catch(() => {})
        ),
      ]);
    }
    return hasSessdata;
  } catch {
    return false;
  }
}

async function getBilibiliAnchorName(uid: number | undefined): Promise<string | undefined> {
  if (!uid || !Number.isFinite(uid) || uid <= 0) return undefined;
  const cached = bilibiliAnchorCache.get(uid);
  if (cached) return cached;
  try {
    const resp = await fetchWithTimeout(
      `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`,
      {
        headers: {
          'User-Agent': DESKTOP_UA,
          Referer: 'https://live.bilibili.com/',
        },
      },
      1200
    );
    const json = (await resp.json()) as { data?: { info?: { uname?: string } } };
    const uname = json?.data?.info?.uname?.trim();
    if (uname) {
      bilibiliAnchorCache.set(uid, uname);
      return uname;
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

async function extractBilibili(
  req: DirectStreamRequest,
  liveSession: Session
): Promise<DirectStreamResult> {
  const referer = `https://live.bilibili.com/${req.roomId}`;
  const targetQn = req.qualityId || (req.autoHighestQuality !== false ? '30000' : '400');

  // Step 1: Ensure live session cookies (SESSDATA/buvid3/LIVE_BUVID), resolve real long room_id, and fetch WBI keys in parallel.
  // Using liveSession.fetch() uses real Chromium TLS + the full persist:livehub cookie jar (including bili_ticket/_uuid/LIVE_BUVID).
  const [hasSessdata, wbiKeys, infoResp] = await Promise.all([
    ensureBilibiliLiveCookies(liveSession),
    getBilibiliWbiKeys(liveSession),
    sessionFetchWithTimeout(
      liveSession,
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(req.roomId)}`,
      2000
    )
      .then((r) => r.json())
      .catch(() => null),
  ]);

  const infoData = (infoResp as {
    code?: number;
    data?: {
      title?: string;
      live_status?: number;
      uid?: number;
      room_id?: number;
      area_name?: string;
      parent_area_name?: string;
      tags?: string;
    };
  } | null)?.data;
  const category = resolveBilibiliCategory(infoData);

  const cachedRid = bilibiliRealRidCache.get(req.roomId);
  const realRid = String(infoData?.room_id || cachedRid?.realRid || req.roomId);
  if (infoData?.room_id) {
    bilibiliRealRidCache.set(req.roomId, { realRid, uid: infoData.uid });
  }

  type BiliPlayInfoData = {
    uid?: number;
    room_id?: number;
    live_status?: number;
    playurl_info?: {
      playurl?: {
        g_qn_desc?: Array<{ qn: number; desc: string; eotf?: number }>;
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

  const fetchBiliPlayInfo = async (qnVal: string): Promise<BiliPlayInfoData | undefined> => {
    const playQuery = buildBilibiliWbiQuery(
      {
        room_id: realRid,
        no_playurl: 0,
        mask: 1,
        qn: qnVal,
        platform: 'web',
        protocol: '0,1',
        format: '0,1,2',
        codec: '0,1,2',
        dolby: 5,
        panorama: 1,
        ptype: 8,
      },
      wbiKeys
    );
    const playResp = await sessionFetchWithTimeout(
      liveSession,
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${playQuery}`,
      5500
    ).then((r) => r.json());
    return (playResp as { code?: number; data?: BiliPlayInfoData })?.data;
  };

  type CodecEntry = {
    formatName: string;
    codecName: string;
    currentQn: number;
    acceptQn: number[];
    urls: string[];
  };

  const requestedQnNum = req.qualityId ? Number(req.qualityId) : NaN;
  const hasExplicitReqQn = Number.isFinite(requestedQnNum) && requestedQnNum > 0;
  const codecPriority = (c: string) => (c === 'avc' ? 0 : c === 'hevc' ? 1 : c === 'av1' ? 2 : 3);
  const sortBestEntry = (entries: CodecEntry[], preferFmp4: boolean) =>
    [...entries].sort((a, b) => {
      if (hasExplicitReqQn) {
        const aExact = a.currentQn === requestedQnNum ? 0 : 1;
        const bExact = b.currentQn === requestedQnNum ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aDiff = Math.abs(a.currentQn - requestedQnNum);
        const bDiff = Math.abs(b.currentQn - requestedQnNum);
        if (aDiff !== bDiff) return aDiff - bDiff;
      }
      if (b.currentQn !== a.currentQn) return b.currentQn - a.currentQn;
      if (preferFmp4) {
        const fa = a.formatName === 'fmp4' ? 0 : 1;
        const fb = b.formatName === 'fmp4' ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      return codecPriority(a.codecName) - codecPriority(b.codecName);
    });

  const parseBiliStreams = (data: BiliPlayInfoData | undefined) => {
    const playurl = data?.playurl_info?.playurl;
    const descMap = new Map<number, string>();
    for (const item of playurl?.g_qn_desc || []) {
      if (!descMap.has(item.qn) || item.eotf === 0) {
        descMap.set(item.qn, item.desc);
      }
    }
    const flvEntries: CodecEntry[] = [];
    const hlsEntries: CodecEntry[] = [];
    for (const st of playurl?.stream || []) {
      for (const fmt of st.format || []) {
        for (const cd of fmt.codec || []) {
          const sortedUrls = [...(cd.url_info || [])]
            .sort((a, b) => scoreBilibiliHost(a.host) - scoreBilibiliHost(b.host))
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
    const flvCodec = sortBestEntry(flvEntries, false)[0];
    const hlsCodec = sortBestEntry(hlsEntries, true)[0];
    const flvExactMatch = Boolean(hasExplicitReqQn && flvCodec && flvCodec.currentQn === requestedQnNum);
    const hlsExactMatch = Boolean(hasExplicitReqQn && hlsCodec && hlsCodec.currentQn === requestedQnNum);
    const useHlsAsPrimary = Boolean(
      hlsCodec &&
        (!flvCodec ||
          (hlsExactMatch && !flvExactMatch) ||
          (!flvExactMatch && hlsCodec.currentQn > flvCodec.currentQn))
    );
    const primary = useHlsAsPrimary ? hlsCodec : flvCodec || hlsCodec;
    const allAcceptQns = Array.from(
      new Set([...flvEntries, ...hlsEntries].flatMap((e) => e.acceptQn))
    ).sort((a, b) => b - a);
    return { descMap, flvEntries, hlsEntries, flvCodec, hlsCodec, useHlsAsPrimary, primary, allAcceptQns };
  };

  // Step 2: Request getRoomPlayInfo with real long room_id, codec=0,1,2 (AVC/HEVC/AV1), WBI signature, and full Chromium session cookies.
  let playData = await fetchBiliPlayInfo(targetQn);

  const title = infoData?.title;
  const uid = playData?.uid ?? infoData?.uid ?? cachedRid?.uid;
  const liveStatus = playData?.live_status ?? infoData?.live_status;

  if (!playData || liveStatus !== 1) {
    const anchorName = await getBilibiliAnchorName(uid);
    return {
      ok: false,
      platform: 'bilibili',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      category,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  let parsedStreams = parseBiliStreams(playData);

  // Guard against Bilibili's classic getRoomPlayInfo fallback bug: requesting qn=30000 on a room whose
  // accept_qn only goes up to 10000/20000 (or 250/400 when logged out) can silently drop to qn=150/250.
  // Retry with the exact highest supported qn from accept_qn so we never settle for a blurry fallback!
  if (!hasExplicitReqQn && req.autoHighestQuality !== false && parsedStreams.primary && parsedStreams.allAcceptQns.length > 0) {
    const currentQn = parsedStreams.primary.currentQn;
    const retryCandidates = parsedStreams.allAcceptQns
      .filter((qn) => qn > currentQn && String(qn) !== targetQn && (hasSessdata || qn <= 400))
      .slice(0, 2);
    for (const candidateQn of retryCandidates) {
      try {
        const upgradedData = await fetchBiliPlayInfo(String(candidateQn));
        const upgraded = parseBiliStreams(upgradedData);
        if (upgraded.primary && upgraded.primary.currentQn > parsedStreams.primary.currentQn) {
          playData = upgradedData;
          parsedStreams = upgraded;
          if (upgraded.primary.currentQn >= candidateQn) break;
        }
      } catch {
        // Keep best stream obtained so far
      }
    }
  }

  const { descMap, flvEntries, hlsEntries, flvCodec, hlsCodec, useHlsAsPrimary, primary } = parsedStreams;

  if (!primary) {
    const anchorName = await getBilibiliAnchorName(uid);
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

  const activeCodec = useHlsAsPrimary ? hlsCodec : flvCodec;
  const maxLines = Math.max(
    useHlsAsPrimary ? 0 : flvCodec?.urls.length || 0,
    hlsCodec?.urls.length || 0
  );
  let lineIdx = Math.min(
    Math.max(0, Number.parseInt(req.lineId || '0', 10) || 0),
    Math.max(0, maxLines - 1)
  );
  let fastestActiveUrl: string | undefined;

  // If user/failover explicitly selected another line, invalidate cached CDN preference
  if (req.lineId) {
    cachedFastBiliHost = null;
  }
  // Run anchor-name lookup in parallel with CDN racing so metadata adds 0ms to startup!
  const shouldRace = !req.lineId && Boolean(activeCodec && activeCodec.urls.length > 1);
  const [anchorName, raced] = await Promise.all([
    getBilibiliAnchorName(uid),
    shouldRace && activeCodec
      ? raceFastestBilibiliUrl(activeCodec.urls, {
          'User-Agent': DESKTOP_UA,
          Referer: referer,
        })
      : Promise.resolve(null),
  ]);

  if (raced) {
    lineIdx = raced.index;
    fastestActiveUrl = raced.finalUrl;
    recordDiagnostic(
      'info',
      'stream',
      `[bilibili#${req.roomId}] 测速择优命中线路 ${lineIdx + 1}（${raced.ms}ms，${useHlsAsPrimary ? 'HLS-fMP4' : 'FLV'} qn=${primary.currentQn}）`
    );
  }

  const flvUrl = useHlsAsPrimary
    ? undefined
    : fastestActiveUrl || flvCodec?.urls[Math.min(lineIdx, flvCodec.urls.length - 1)];
  const hlsUrl = useHlsAsPrimary
    ? fastestActiveUrl || hlsCodec?.urls[Math.min(lineIdx, hlsCodec.urls.length - 1)]
    : hlsCodec?.urls[Math.min(lineIdx, hlsCodec.urls.length - 1)];

  const allAcceptQns = Array.from(
    new Set([...flvEntries, ...hlsEntries].flatMap((e) => e.acceptQn))
  ).sort((a, b) => b - a);
  const displayQns = allAcceptQns.length > 0 ? allAcceptQns : primary.acceptQn;

  const qualities: StreamOptionItem[] = displayQns.map((qn) => ({
    id: String(qn),
    label: descMap.get(qn) || `${qn}P`,
    active: qn === primary.currentQn,
    locked: !hasSessdata && qn > Math.max(250, primary.currentQn),
  }));

  const lines: StreamOptionItem[] = Array.from({ length: maxLines }, (_, i) => {
    const sampleUrl =
      (useHlsAsPrimary ? hlsCodec?.urls[i] : flvCodec?.urls[i] || hlsCodec?.urls[i]) || '';
    return {
      id: String(i),
      label: labelBilibiliUrl(sampleUrl, i),
      active: i === lineIdx,
    };
  });

  recordDiagnostic(
    'info',
    'stream',
    `[bilibili#${req.roomId}] realRid=${realRid} ${hasSessdata ? '已登录' : '未登录'} 请求qn=${targetQn} -> 实际qn=${primary.currentQn} (${primary.formatName}/${primary.codecName})`
  );

  return {
    ok: true,
    platform: 'bilibili',
    roomId: req.roomId,
    status: 'live',
    title,
    anchorName,
    category,
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
  }, 20_000);
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
        partition: 'douyu-signer',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: false,
      },
    });
    try {
      // Use about:blank instead of data:text/html to avoid Electron ERR_FAILED (-2) races
      await win.loadURL('about:blank');
      await win.webContents.executeJavaScript(PURE_JS_MD5_SOURCE);
    } catch (err) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        // Ignore
      }
      throw err;
    }
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

function runDouyuSignInVm(jsCode: string, rid: string, did: string, tt: number): string {
  const sandbox: Record<string, unknown> = {
    CryptoJS: {
      MD5: (s: unknown) => ({ toString: () => md5(String(s)) }),
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const script = `${jsCode};\nString(ub98484234(${JSON.stringify(rid)}, ${JSON.stringify(did)}, ${tt}));`;
  const res = vm.runInNewContext(script, sandbox, { timeout: 1500 });
  return String(res || '');
}

async function runDouyuSignInSandbox(
  jsCode: string,
  rid: string,
  did: string,
  tt: number
): Promise<string> {
  // Primary fast-path: isolated node:vm context (~0.3ms, zero extra BrowserWindow process overhead)
  try {
    const vmRes = runDouyuSignInVm(jsCode, rid, did, tt);
    if (vmRes && vmRes.includes('sign=')) {
      return vmRes;
    }
  } catch {
    // Fall back to hidden BrowserWindow sandbox if Douyu script requires full DOM
  }

  try {
    const win = await getDouyuSignerWindow();
    touchDouyuSignerIdle();
    const script = `${jsCode};\nString(ub98484234(${JSON.stringify(rid)}, ${JSON.stringify(did)}, ${tt}));`;
    const result = await Promise.race<string>([
      win.webContents.executeJavaScript(script) as Promise<string>,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('斗鱼签名执行超时')), 3000)
      ),
    ]);
    return String(result || '');
  } catch (err) {
    recordDiagnostic(
      'warn',
      'stream',
      `[douyu#${rid}] 签名执行异常：${err instanceof Error ? err.message : String(err)}`
    );
    return '';
  }
}

async function extractDouyu(
  req: DirectStreamRequest,
  liveSession: Session
): Promise<DirectStreamResult> {
  const douyuCookies = await liveSession.cookies.get({ domain: 'douyu.com' }).catch(() => []);
  const dedupDouyu = new Map<string, string>();
  for (const c of douyuCookies) {
    if (!c.name || !c.value) continue;
    if (!dedupDouyu.has(c.name) || (c.domain || '').startsWith('.')) {
      dedupDouyu.set(c.name, c.value);
    }
  }
  const hasDouyuAuth = Boolean(
    dedupDouyu.get('acf_auth') || dedupDouyu.get('dy_auth') || dedupDouyu.get('acf_uid')
  );
  const cookieDid = dedupDouyu.get('dy_did') || dedupDouyu.get('acf_did');
  const cookie = Array.from(dedupDouyu.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const resolved = await resolveDouyuRealRid(req.roomId);
  const rid = resolved.rid;
  const referer = `https://www.douyu.com/${rid}`;
  const commonHeaders: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Referer: referer,
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const douyuFetchJson = async <T>(
    url: string,
    init: RequestInit = {},
    timeoutMs = 6500
  ): Promise<T> => {
    try {
      const resp = await sessionFetchWithTimeout(liveSession, url, timeoutMs, init);
      return (await resp.json()) as T;
    } catch {
      const resp = await fetchWithTimeout(
        url,
        {
          ...init,
          headers: {
            ...commonHeaders,
            ...(init.headers as Record<string, string> | undefined),
          },
        },
        timeoutMs
      );
      return (await resp.json()) as T;
    }
  };

  const roomInfo =
    resolved.room ?? (await fetchDouyuBetard(rid, cookie ? { Cookie: cookie } : {}, liveSession));
  const title = roomInfo?.room_name;
  const anchorName = roomInfo?.nickname;
  const category = (roomInfo?.second_lvl_name || roomInfo?.cate_name || '').trim() || undefined;

  if (roomInfo && roomInfo.show_status !== 1) {
    return {
      ok: false,
      platform: 'douyu',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      category,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  const encRes = await douyuFetchJson<{ data?: Record<string, string> }>(
    `https://www.douyu.com/swf_api/homeH5Enc?rids=${encodeURIComponent(rid)}`
  );

  const jsCode = encRes?.data?.[`room${rid}`];
  if (!jsCode) {
    return {
      ok: false,
      platform: 'douyu',
      roomId: req.roomId,
      status: 'error',
      title,
      anchorName,
      category,
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

  type DouyuPlayRes = {
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

  const requestDouyuPlay = (rateVal: string) => {
    const body = `${signQuery}&cdn=${encodeURIComponent(targetCdn)}&rate=${encodeURIComponent(rateVal)}&ver=Douyu_223061205&iar=0&ive=0&hevc=0&fa=0`;
    return douyuFetchJson<DouyuPlayRes>(`https://www.douyu.com/lapi/live/getH5Play/${rid}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  };

  let playRes = await requestDouyuPlay(targetRate);

  if (playRes?.error !== 0 || !playRes.data?.rtmp_url || !playRes.data?.rtmp_live) {
    const isOffline = playRes?.error === -5;
    return {
      ok: false,
      platform: 'douyu',
      roomId: req.roomId,
      status: isOffline ? 'offline' : 'error',
      title,
      anchorName,
      category,
      referer,
      qualities: [],
      lines: [],
      error: playRes?.msg || '获取斗鱼直播流失败',
    };
  }

  // If rate=0 (原画) was restricted and Douyu dropped all the way down to 高清(rate=2),
  // probe the highest intermediate bitrate (e.g. 蓝光4M / 超清) so we get the sharpest unlocked stream.
  if (!req.qualityId && req.autoHighestQuality !== false && targetRate === '0') {
    const initialRates = playRes.data.multirates || [];
    const curIdx = initialRates.findIndex((m) => m.rate === playRes.data?.rate);
    if (curIdx > 1) {
      const candidate = initialRates.slice(0, curIdx).find((m) => m.rate !== 0);
      if (candidate) {
        try {
          const retryRes = await requestDouyuPlay(String(candidate.rate));
          if (retryRes?.error === 0 && retryRes.data?.rtmp_url && retryRes.data?.rtmp_live) {
            const retryIdx = (retryRes.data.multirates || initialRates).findIndex(
              (m) => m.rate === retryRes.data?.rate
            );
            if (retryIdx >= 0 && retryIdx < curIdx) {
              playRes = retryRes;
            }
          }
        } catch {
          // Keep initial stream
        }
      }
    }
  }

  const d = playRes.data!;
  const flvUrl = `${d.rtmp_url}/${d.rtmp_live}`;

  const multirates = d.multirates || [];
  const activeIdx = multirates.findIndex((m) => m.rate === d.rate);
  const requestedRateNum = Number(targetRate);
  const downgradedHighest =
    !hasDouyuAuth &&
    activeIdx > 0 &&
    (targetRate === '0' ||
      (Number.isFinite(requestedRateNum) &&
        multirates.findIndex((m) => m.rate === requestedRateNum) < activeIdx));

  const qualities: StreamOptionItem[] = multirates.map((m, idx) => ({
    id: String(m.rate),
    label: m.name,
    active: m.rate === d.rate,
    locked: !hasDouyuAuth && ((downgradedHighest && idx < activeIdx) || (m.rate === 0 && d.rate !== 0)),
  }));
  if (qualities.length > 0 && !qualities.some((q) => q.active)) {
    qualities[0].active = true;
  }

  const lines: StreamOptionItem[] = (d.cdnsWithName || []).map((c) => ({
    id: c.cdn,
    label: c.name || c.cdn,
    active: c.cdn === d.rtmp_cdn,
  }));

  recordDiagnostic(
    'info',
    'stream',
    `[douyu#${rid}] ${hasDouyuAuth ? '已登录' : '未登录'} 请求rate=${targetRate} -> 实际rate=${d.rate} (cdn=${d.rtmp_cdn || ''})`
  );

  return {
    ok: true,
    platform: 'douyu',
    roomId: req.roomId,
    status: 'live',
    title,
    anchorName,
    category,
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

  type DouyinEnterResponse = {
    status_code?: number;
    data?: {
      user?: { nickname?: string };
      partition_road_map?: {
        partition?: { title?: string };
        sub_partition?: { title?: string };
      };
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

  const fetchEnterJson = async (forceRefresh: boolean): Promise<DouyinEnterResponse | null> => {
    const cookieHeader = await getDouyinCookieHeader(forceRefresh);
    const resp = await fetchWithTimeout(apiUrl, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: referer,
        Cookie: cookieHeader,
      },
    });
    const raw = (await resp.text()).trim();
    if (!raw || !raw.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(raw) as DouyinEnterResponse;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  let json = await fetchEnterJson(false);
  if (!json?.data) {
    json = await fetchEnterJson(true);
  }
  if (!json?.data) {
    return {
      ok: false,
      platform: 'douyin',
      roomId: req.roomId,
      status: 'error',
      referer,
      qualities: [],
      lines: [],
      error: '抖音接口返回空或触发风控，可重试或切网页模式',
    };
  }

  const room = json?.data?.data?.[0];
  const title = room?.title;
  const anchorName = json?.data?.user?.nickname;
  const category =
    (
      json?.data?.partition_road_map?.sub_partition?.title ||
      json?.data?.partition_road_map?.partition?.title ||
      ''
    ).trim() || undefined;

  if (!room || room.status !== 2) {
    return {
      ok: false,
      platform: 'douyin',
      roomId: req.roomId,
      status: 'offline',
      title,
      anchorName,
      category,
      referer,
      qualities: [],
      lines: [],
      error: '主播暂未开播',
    };
  }

  // Prefer live_core_sdk_data (which includes true 'origin' / 'uhd_60' stream); fall back to flv_pull_url / hls_pull_url_map
  const flvMap = new Map<string, string>();
  const hlsMap = new Map<string, string>();
  const bitrateMap = new Map<string, number>();

  const sdkRaw = room.stream_url?.live_core_sdk_data?.pull_data?.stream_data;
  if (sdkRaw) {
    try {
      const parsed = JSON.parse(sdkRaw) as {
        data?: Record<string, { main?: { flv?: string; hls?: string; sdk_params?: string } }>;
      };
      for (const [key, val] of Object.entries(parsed.data || {})) {
        if (key === 'ao') continue;
        if (val?.main?.flv) flvMap.set(key, val.main.flv);
        if (val?.main?.hls) hlsMap.set(key, val.main.hls);
        if (val?.main?.sdk_params) {
          try {
            const sp = JSON.parse(val.main.sdk_params) as { vbitrate?: number };
            if (typeof sp.vbitrate === 'number' && Number.isFinite(sp.vbitrate)) {
              bitrateMap.set(key, sp.vbitrate);
            }
          } catch {
            // Ignore malformed sdk_params
          }
        }
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
    const ra = ia === -1 ? 99 : ia;
    const rb = ib === -1 ? 99 : ib;
    if (ra !== rb) return ra - rb;
    return (bitrateMap.get(b) ?? 0) - (bitrateMap.get(a) ?? 0);
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
    category,
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
            liveData?: { introduction?: string; nick?: string; gameFullName?: string };
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
          category: d.liveData?.gameFullName?.trim() || undefined,
          checkedAt,
        };
      }

      case 'douyu': {
        const { room } = await resolveDouyuRealRid(item.roomId);
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
          category: (room.second_lvl_name || room.cate_name || '').trim() || undefined,
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
            uid?: number;
            live_status?: number;
            title?: string;
            area_name?: string;
            parent_area_name?: string;
            tags?: string;
          };
        };
        const info = json?.data;
        if (json?.code !== 0 || !info) return { status: 'unknown', checkedAt };
        const status =
          info.live_status === 1 ? 'live' : info.live_status === 2 ? 'replay' : 'offline';
        const anchorName = await getBilibiliAnchorName(info.uid);
        return {
          status,
          anchorName,
          title: info.title,
          category: resolveBilibiliCategory(info),
          checkedAt,
        };
      }

      case 'douyin': {
        if (!item.roomId || item.roomId === 'home' || !/^\d+$/.test(item.roomId)) {
          return { status: 'unknown', checkedAt };
        }
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
              partition_road_map?: {
                partition?: { title?: string };
                sub_partition?: { title?: string };
              };
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
        const category =
          (
            parsed.data.partition_road_map?.sub_partition?.title ||
            parsed.data.partition_road_map?.partition?.title ||
            ''
          ).trim() || undefined;
        return {
          status,
          anchorName: parsed.data.user?.nickname || room?.owner?.nickname,
          title: room?.title,
          category,
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

async function checkBilibiliStatusesBatch(
  items: LiveStatusCheckItem[],
  results: Record<string, LiveRoomStatus>
): Promise<LiveStatusCheckItem[]> {
  if (items.length <= 1) return items;
  const fallback: LiveStatusCheckItem[] = [];
  const checkedAt = Date.now();

  for (let start = 0; start < items.length; start += 30) {
    const chunk = items.slice(start, start + 30);
    const validChunk = chunk.filter((i) => /^\d+$/.test(i.roomId.trim()));
    const invalidChunk = chunk.filter((i) => !/^\d+$/.test(i.roomId.trim()));
    fallback.push(...invalidChunk);
    if (validChunk.length === 0) continue;

    try {
      const qs = validChunk
        .map((i) => `room_ids=${encodeURIComponent(i.roomId.trim())}`)
        .join('&');
      const resp = await fetchWithTimeout(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?req_biz=web_room_componet&${qs}`,
        {
          headers: {
            'User-Agent': DESKTOP_UA,
            Referer: 'https://live.bilibili.com/',
          },
        },
        7000
      );
      const json = (await resp.json()) as {
        code?: number;
        data?: {
          by_room_ids?: Record<
            string,
            {
              room_id?: number;
              short_id?: number;
              uid?: number;
              live_status?: number;
              title?: string;
              uname?: string;
              area_name?: string;
              parent_area_name?: string;
              tags?: string;
            }
          >;
        };
      };
      const byRoomIds = json?.code === 0 ? json?.data?.by_room_ids : undefined;
      if (!byRoomIds || typeof byRoomIds !== 'object') {
        fallback.push(...validChunk);
        continue;
      }

      const byShortId = new Map<string, (typeof byRoomIds)[string]>();
      for (const info of Object.values(byRoomIds)) {
        if (info?.short_id) byShortId.set(String(info.short_id), info);
        if (info?.room_id) byShortId.set(String(info.room_id), info);
      }

      for (const item of validChunk) {
        const key = item.roomId.trim();
        const info = byRoomIds[key] || byShortId.get(key);
        if (!info) {
          fallback.push(item);
          continue;
        }
        if (info.uid && info.uname?.trim()) {
          bilibiliAnchorCache.set(info.uid, info.uname.trim());
        }
        if (info.room_id) {
          bilibiliRealRidCache.set(item.roomId, {
            realRid: String(info.room_id),
            uid: info.uid,
          });
        }
        const status =
          info.live_status === 1 ? 'live' : info.live_status === 2 ? 'replay' : 'offline';
        results[item.id] = {
          status,
          anchorName: info.uname?.trim() || undefined,
          title: info.title,
          category: resolveBilibiliCategory(info),
          checkedAt,
        };
      }
    } catch {
      fallback.push(...validChunk);
    }
  }

  return fallback;
}

export async function checkLiveStatuses(
  items: LiveStatusCheckItem[]
): Promise<Record<string, LiveRoomStatus>> {
  const results: Record<string, LiveRoomStatus> = {};
  if (!Array.isArray(items) || items.length === 0) return results;

  const biliItems = items.filter((i) => i.platform === 'bilibili');
  const otherItems = items.filter((i) => i.platform !== 'bilibili');

  // Batch-check Bilibili rooms in a single HTTP request (falls back per-room if any missed)
  // while warming anonymous Douyin ttwid in parallel if needed
  const [biliFallback] = await Promise.all([
    biliItems.length > 1 ? checkBilibiliStatusesBatch(biliItems, results) : Promise.resolve(biliItems),
    otherItems.some((i) => i.platform === 'douyin')
      ? getDouyinCookieHeader(false).catch(() => '')
      : Promise.resolve(''),
  ]);

  const remaining = [...otherItems, ...biliFallback];
  if (remaining.length === 0) return results;

  const concurrency = 6;
  let cursor = 0;

  const worker = async () => {
    while (cursor < remaining.length) {
      const idx = cursor++;
      const item = remaining[idx];
      if (!item) break;
      results[item.id] = await checkSingleLiveStatus(item);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, remaining.length) }, () => worker())
  );
  return results;
}
