import type { Channel, ChannelPlatform, LayoutMode, PlatformId } from './types';

export interface PlatformMeta {
  id: PlatformId;
  name: string;
  shortName: string;
  color: string;
  bgTint: string;
  homeUrl: string;
  loginUrl: string;
  domainPatterns: string[];
}

export interface ChannelPlatformMeta {
  id: ChannelPlatform;
  name: string;
  shortName: string;
  color: string;
  bgTint: string;
}

export const PLATFORMS: Record<PlatformId, PlatformMeta> = {
  huya: {
    id: 'huya',
    name: '虎牙直播',
    shortName: '虎牙',
    color: '#d97706',
    bgTint: 'rgba(217, 119, 6, 0.12)',
    homeUrl: 'https://www.huya.com',
    loginUrl: 'https://i.huya.com/',
    domainPatterns: ['huya.com'],
  },
  douyu: {
    id: 'douyu',
    name: '斗鱼直播',
    shortName: '斗鱼',
    color: '#ea580c',
    bgTint: 'rgba(234, 88, 12, 0.12)',
    homeUrl: 'https://www.douyu.com',
    loginUrl: 'https://passport.douyu.com/',
    domainPatterns: ['douyu.com'],
  },
  bilibili: {
    id: 'bilibili',
    name: 'B站直播',
    shortName: 'B站',
    color: '#0284c7',
    bgTint: 'rgba(2, 132, 199, 0.12)',
    homeUrl: 'https://live.bilibili.com',
    loginUrl: 'https://passport.bilibili.com/login?gourl=https%3A%2F%2Flive.bilibili.com%2F',
    domainPatterns: ['live.bilibili.com', 'bilibili.com'],
  },
  douyin: {
    id: 'douyin',
    name: '抖音直播',
    shortName: '抖音',
    color: '#e11d48',
    bgTint: 'rgba(225, 29, 72, 0.12)',
    homeUrl: 'https://live.douyin.com',
    loginUrl: 'https://live.douyin.com/',
    domainPatterns: ['live.douyin.com', 'douyin.com'],
  },
};

export const PLATFORM_LIST: PlatformMeta[] = [
  PLATFORMS.huya,
  PLATFORMS.douyu,
  PLATFORMS.bilibili,
  PLATFORMS.douyin,
];

export const WEB_PLATFORM_META: ChannelPlatformMeta = {
  id: 'web',
  name: '自由网页',
  shortName: '网页',
  color: '#6366f1',
  bgTint: 'rgba(99, 102, 241, 0.13)',
};

export const CHANNEL_PLATFORMS: Record<ChannelPlatform, ChannelPlatformMeta> = {
  ...PLATFORMS,
  web: WEB_PLATFORM_META,
};

export const CHANNEL_PLATFORM_LIST: ChannelPlatformMeta[] = [
  ...PLATFORM_LIST,
  WEB_PLATFORM_META,
];

export function isLivePlatform(
  platform: ChannelPlatform | null | undefined
): platform is PlatformId {
  return (
    platform === 'huya' ||
    platform === 'douyu' ||
    platform === 'bilibili' ||
    platform === 'douyin'
  );
}

export function getChannelPlatformMeta(platform: ChannelPlatform): ChannelPlatformMeta {
  return CHANNEL_PLATFORMS[platform] ?? WEB_PLATFORM_META;
}

export const QUICK_WEB_PRESETS: Array<{ name: string; url: string; roomId: string }> = [
  { name: '抖音', url: 'https://www.douyin.com/', roomId: 'www.douyin.com' },
  { name: 'B站', url: 'https://www.bilibili.com/', roomId: 'www.bilibili.com' },
  { name: '小红书', url: 'https://www.xiaohongshu.com/', roomId: 'www.xiaohongshu.com' },
  { name: '微博', url: 'https://weibo.com/', roomId: 'weibo.com' },
];

export const LAYOUT_CONFIGS: Record<
  LayoutMode,
  { label: string; count: number; description: string }
> = {
  '1x1': { label: '单屏', count: 1, description: '单屏沉浸 (1×1)' },
  '1x2': { label: '左右双屏', count: 2, description: '左右双屏 (1×2)' },
  '2x1': { label: '上下双屏', count: 2, description: '上下双屏 (2×1)' },
  '1+2': { label: '三屏', count: 3, description: '主副三屏 (1+2)' },
  '2x2': { label: '四屏', count: 4, description: '四分屏同看 (2×2)' },
};

export const DEFAULT_GROUPS = ['全部', 'LOL', '王者', '户外', '娱乐', '综合', '网页'];
export const AUTO_GROUP_VALUE = '__auto__';

export function getVisibleGroups(
  customGroups: string[] = [],
  hiddenDefaultGroups: string[] = [],
  channels: Channel[] = []
): string[] {
  const hiddenSet = new Set(hiddenDefaultGroups.filter((g) => g && g !== '全部'));
  const set = new Set<string>(['全部']);
  for (const g of DEFAULT_GROUPS) {
    if (g !== '全部' && !hiddenSet.has(g)) {
      set.add(g);
    }
  }
  for (const g of customGroups) {
    if (g && g !== '全部') {
      set.add(g);
    }
  }
  for (const ch of channels) {
    if (ch.group && ch.group !== '全部' && !hiddenSet.has(ch.group)) {
      set.add(ch.group);
    }
  }
  return Array.from(set);
}

export function getFallbackGroup(selectableGroups: string[]): string {
  if (selectableGroups.includes('综合')) return '综合';
  return selectableGroups[0] || '未分组';
}

const GROUP_SYNONYM_RULES: Array<{ groupAliases: RegExp; contentPatterns: RegExp }> = [
  {
    groupAliases: /^(lol|英雄联盟|lpl|联盟)$/i,
    contentPatterns: /(英雄联盟|\blol\b|\blpl\b|\blck\b|\bmsi\b|云顶之弈|金铲铲|峡谷之巅|召唤师峡谷|世界赛|全球总决赛)/i,
  },
  {
    groupAliases: /^(王者|王者荣耀|kpl|农药)$/i,
    contentPatterns: /(王者荣耀|\bkpl\b|王者峡谷|巅峰赛|农药)/i,
  },
  {
    groupAliases: /^(户外|生活|美食|旅游|钓鱼)$/i,
    contentPatterns: /(户外|美食|探店|旅游|旅行|赶海|钓鱼|骑行|自驾|日常|生活分享|运动|健身|萌宠)/i,
  },
  {
    groupAliases: /^(娱乐|星秀|颜值|唱歌|音乐|舞蹈|一起看|影视|脱口秀|聊天)$/i,
    contentPatterns: /(娱乐|星秀|颜值|唱歌|音乐|歌会|电台|舞蹈|一起看|影视|电影|脱口秀|相声|聊天|交友|配音|助眠)/i,
  },
  {
    groupAliases: /^(dota2?|刀塔)$/i,
    contentPatterns: /(dota\s*2|dota|刀塔|ti\d+|中单|天梯)/i,
  },
  {
    groupAliases: /^(cs2?|csgo|反恐精英)$/i,
    contentPatterns: /(\bcs2\b|\bcsgo\b|反恐精英|完美平台|faceit|major)/i,
  },
  {
    groupAliases: /^(瓦|无畏契约|valorant)$/i,
    contentPatterns: /(无畏契约|valorant|瓦罗兰特|\bvct\b)/i,
  },
  {
    groupAliases: /^(fps|射击|枪战)$/i,
    contentPatterns: /(\bfps\b|射击|cs2|csgo|无畏契约|valorant|绝地求生|pubg|apex|三角洲|穿越火线|\bcf\b|逃离塔科夫|和平精英|守望先锋|使命召唤|暗区突围)/i,
  },
  {
    groupAliases: /^(吃鸡|pubg|绝地求生|和平精英)$/i,
    contentPatterns: /(绝地求生|\bpubg\b|和平精英|吃鸡)/i,
  },
  {
    groupAliases: /^(三角洲|三角洲行动)$/i,
    contentPatterns: /(三角洲行动|三角洲)/i,
  },
  {
    groupAliases: /^(apex)$/i,
    contentPatterns: /(\bapex\b|apex英雄)/i,
  },
  {
    groupAliases: /^(二次元|虚拟|vtb|vup|虚拟主播)$/i,
    contentPatterns: /(虚拟主播|虚拟偶像|\bvtuber\b|\bvup\b|二次元|原神|星穹铁道|崩坏|鸣潮|绝区零|明日方舟|碧蓝航线)/i,
  },
  {
    groupAliases: /^(单机|主机|steam|独立游戏)$/i,
    contentPatterns: /(单机|主机|steam|黑神话|艾尔登|塞尔达|恐怖游戏|我的世界|minecraft|\bgta\b|饥荒|泰拉瑞亚|博德之门|怪物猎人|魂系)/i,
  },
  {
    groupAliases: /^(赛事|比赛|电竞)$/i,
    contentPatterns: /(游戏赛事|官方赛事|总决赛|\blpl\b|\blck\b|\bkpl\b|major|锦标赛)/i,
  },
  {
    groupAliases: /^(棋牌|麻将|卡牌|桌游)$/i,
    contentPatterns: /(棋牌|斗地主|麻将|象棋|围棋|炉石传说|三国杀|狼人杀|雀魂|鹅鸭杀)/i,
  },
  {
    groupAliases: /^(体育|足球|篮球|nba)$/i,
    contentPatterns: /(体育|\bnba\b|足球|篮球|英超|欧冠|中超|网球|乒乓球|羽毛球|f1|斯诺克)/i,
  },
];

/**
 * Match a channel's live zone/category, title, and anchor name against the user's currently active groups.
 * Returns null if no confident match is found (caller can keep fallback group).
 */
export function matchChannelGroup(
  info: { category?: string; title?: string; anchorName?: string },
  availableGroups: string[]
): string | null {
  const candidates = availableGroups.filter((g) => g && g !== '全部' && g !== '综合' && g !== '未分组');
  if (candidates.length === 0) return null;

  const category = (info.category || '').trim();
  const title = (info.title || '').trim();
  const anchorName = (info.anchorName || '').trim();
  const combined = [category, title, anchorName].filter(Boolean).join(' ');
  if (!combined) return null;

  const catLower = category.toLowerCase();
  const combinedLower = combined.toLowerCase();

  // Tier 1: Exact or direct substring match between live category and an existing group name
  if (catLower) {
    const exact = candidates.find((g) => g.toLowerCase() === catLower);
    if (exact) return exact;
    const catContainsGroup = candidates.find(
      (g) => g.length >= 2 && (catLower.includes(g.toLowerCase()) || g.toLowerCase().includes(catLower))
    );
    if (catContainsGroup) return catContainsGroup;
  }

  // Tier 2: Synonym/keyword rules checked against category first (highest precision), then full text
  for (const text of category ? [category, combined] : [combined]) {
    for (const rule of GROUP_SYNONYM_RULES) {
      if (!rule.contentPatterns.test(text)) continue;
      const matchedGroup = candidates.find((g) => rule.groupAliases.test(g.trim()));
      if (matchedGroup) return matchedGroup;
    }
  }

  // Tier 3: Substring match of a user's custom group name (length >= 2) inside room title or anchor name
  const titleHit = candidates.find((g) => g.length >= 2 && combinedLower.includes(g.toLowerCase()));
  if (titleHit) return titleHit;

  return null;
}

export function buildCanonicalUrl(platform: PlatformId, roomId: string): string {
  const cleanId = roomId.trim().replace(/^\/+/, '');
  switch (platform) {
    case 'huya':
      return cleanId ? `https://www.huya.com/${cleanId}` : 'https://www.huya.com';
    case 'douyu':
      return cleanId ? `https://www.douyu.com/${cleanId}` : 'https://www.douyu.com';
    case 'bilibili':
      return cleanId ? `https://live.bilibili.com/${cleanId}` : 'https://live.bilibili.com';
    case 'douyin':
      return !cleanId || cleanId === 'home'
        ? 'https://live.douyin.com'
        : `https://live.douyin.com/${cleanId}`;
  }
}

export type ParsedLiveResult =
  | {
      ok: true;
      platform: ChannelPlatform;
      roomId: string;
      url: string;
      suggestedName?: string;
    }
  | {
      ok: false;
      needsPlatform: boolean;
      needsShortResolve?: boolean;
      shortUrl?: string;
      platformHint?: PlatformId;
      suggestedName?: string;
      roomId?: string;
      reason: string;
    };

const BARE_DOMAIN_RE =
  /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|tv|io|me|cc|co|app|dev|xyz|top|vip|gov|edu|hk|tw|jp|uk|de|fr|ai|gg|fm|ly|im|live|video|news|wiki|info|biz|pro|site|online|club|fun)(?::\d{2,5})?(?:[/?#][^\s"'<>]*)?$/i;

const LOCALHOST_RE = /^(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:[/?#][^\s"'<>]*)?$/i;

export function normalizeWebUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const httpMatch = trimmed.match(/https?:\/\/[^\s"'<>，。；！]+/i);
  let candidate = httpMatch
    ? httpMatch[0].replace(/[),.;!?，。；！？]+$/, '')
    : trimmed;

  if (!/^https?:\/\//i.test(candidate)) {
    if (LOCALHOST_RE.test(candidate)) {
      candidate = `http://${candidate}`;
    } else if (BARE_DOMAIN_RE.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildWebRoomId(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.host.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '');
    const search = parsed.search && parsed.search.length <= 48 ? parsed.search : '';
    const combined = `${host}${path}${search}`;
    return combined.length > 72 ? combined.slice(0, 72) : combined;
  } catch {
    return rawUrl.slice(0, 64);
  }
}

export function suggestWebSiteName(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
      if (path.startsWith('/video/')) return '抖音视频';
      if (path.startsWith('/user/')) return '抖音主页';
      return '抖音';
    }
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
      if (path.startsWith('/video/')) return 'B站视频';
      if (host.startsWith('space.')) return 'B站空间';
      if (host.startsWith('search.')) return 'B站搜索';
      return 'B站';
    }
    if (host.includes('xiaohongshu.com')) return '小红书';
    if (host.includes('weibo.com') || host.includes('weibo.cn')) return '微博';
    if (host.includes('zhihu.com')) return '知乎';
    if (host.includes('youtube.com') || host === 'youtu.be') return 'YouTube';
    if (host.includes('twitch.tv')) return 'Twitch';
    if (host.includes('tieba.baidu.com')) return '贴吧';
    if (host.includes('douban.com')) return '豆瓣';
    if (host.includes('nga.cn') || host.includes('ngabbs.com')) return 'NGA';
    if (host.includes('hupu.com')) return '虎扑';
    if (host === 'x.com' || host.includes('twitter.com')) return 'X';
    if (host.includes('github.com')) return 'GitHub';
    return host;
  } catch {
    return '自由网页';
  }
}

export function formatWebUrlLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    const text = `${host}${path}`;
    return text.length > 36 ? `${text.slice(0, 35)}…` : text;
  } catch {
    return rawUrl;
  }
}

function extractEmbeddedUrl(input: string): string | null {
  const httpMatch = input.match(/https?:\/\/[^\s"'<>，。；！]+/i);
  if (httpMatch) {
    return httpMatch[0].replace(/[),.;!?，。；！？]+$/, '');
  }
  const bareDomainMatch = input.match(
    /(?:[a-z0-9-]+\.)?(?:huya\.com|douyu\.com|douyucdn\.cn|live\.bilibili\.com|bilibili\.com|b23\.tv|live\.douyin\.com|v\.douyin\.com|douyin\.com|iesdouyin\.com|webcast\.amemv\.com)[^\s"'<>，。；！]*/i
  );
  if (bareDomainMatch) {
    return `https://${bareDomainMatch[0].replace(/[),.;!?，。；！？]+$/, '')}`;
  }
  return null;
}

export function parseLiveInput(
  rawInput: string,
  fallbackPlatform?: ChannelPlatform
): ParsedLiveResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, needsPlatform: false, reason: '请输入直播间链接、房间号或任意网址' };
  }

  // Extract share title like 【主播名】 when available
  const shareTitleMatch = trimmed.match(/【([^【】]{1,28})】/);
  const suggestedName = shareTitleMatch ? shareTitleMatch[1].replace(/的(?:斗鱼|虎牙|抖音|B站)?直播间?$/, '').trim() : undefined;

  // 0. Explicit free-web mode: treat any valid URL / bare domain directly as a web bookmark
  if (fallbackPlatform === 'web') {
    const normalized = normalizeWebUrl(trimmed);
    if (!normalized) {
      return {
        ok: false,
        needsPlatform: false,
        reason: '请输入有效网址，例如 https://www.douyin.com 或 bilibili.com',
      };
    }
    return {
      ok: true,
      platform: 'web',
      roomId: buildWebRoomId(normalized),
      url: normalized,
      suggestedName: suggestedName || suggestWebSiteName(normalized),
    };
  }

  // 1. Check prefixed syntax like "hy:660000", "虎牙 660000", "斗鱼房间号：728", "抖音123456"
  const prefixMatch = trimmed.match(
    /^(huya|hy|虎牙|douyu|dy|斗鱼|bilibili|bl|b站|bili|douyin|dyin|抖音)(?:直播间?|房间号?|房号)?(?:[\s:：/#]+|(?=\d))([a-zA-Z0-9_.-]+)$/i
  );
  if (prefixMatch) {
    const rawPrefix = prefixMatch[1].toLowerCase();
    const roomId = prefixMatch[2];
    let platform: PlatformId = 'huya';
    if (['huya', 'hy', '虎牙'].includes(rawPrefix)) platform = 'huya';
    else if (['douyu', 'dy', '斗鱼'].includes(rawPrefix)) platform = 'douyu';
    else if (['bilibili', 'bl', 'b站', 'bili'].includes(rawPrefix)) platform = 'bilibili';
    else if (['douyin', 'dyin', '抖音'].includes(rawPrefix)) platform = 'douyin';
    return {
      ok: true,
      platform,
      roomId,
      url: buildCanonicalUrl(platform, roomId),
      suggestedName,
    };
  }

  // 2. Extract URL even when wrapped inside App share text (e.g. "8.97 复制打开抖音... https://v.douyin.com/...")
  const extractedUrl = extractEmbeddedUrl(trimmed) ?? normalizeWebUrl(trimmed);
  if (extractedUrl) {
    try {
      const parsed = new URL(extractedUrl);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.replace(/\/+$/, '');
      const segments = pathname.split('/').filter(Boolean);

      if (host.includes('huya.com')) {
        const roomId = segments[0];
        if (!roomId) {
          return {
            ok: true,
            platform: 'web',
            roomId: buildWebRoomId(extractedUrl),
            url: extractedUrl,
            suggestedName: suggestedName || '虎牙首页',
          };
        }
        return {
          ok: true,
          platform: 'huya',
          roomId,
          url: buildCanonicalUrl('huya', roomId),
          suggestedName,
        };
      }

      // Douyu short links & share links (c.douyu.com, v.douyu.com, wxshare.douyucdn.cn)
      if (
        host === 'c.douyu.com' ||
        host === 'v.douyu.com' ||
        host.includes('wxshare.douyucdn.cn')
      ) {
        return {
          ok: false,
          needsPlatform: false,
          needsShortResolve: true,
          shortUrl: extractedUrl,
          platformHint: 'douyu',
          suggestedName,
          reason: '正在解析斗鱼分享短链...',
        };
      }

      if (host.includes('douyu.com') || host.includes('douyucdn.cn')) {
        const ridParam =
          parsed.searchParams.get('rid') ||
          parsed.searchParams.get('roomId') ||
          parsed.searchParams.get('room_id');

        let roomId: string | undefined = ridParam || undefined;
        if (!roomId) {
          const first = (segments[0] || '').toLowerCase();
          if (first === 'beta' && segments[1]) {
            roomId = segments[1];
          } else if (first === 'room' && segments[1]?.toLowerCase() === 'share' && segments[2]) {
            roomId = segments[2];
          } else if (first === 'room' && segments[1]) {
            roomId = segments[1];
          } else if (first === 'topic') {
            // Topic page without ?rid=... needs server-side HTML lookup to extract real rid
            return {
              ok: false,
              needsPlatform: false,
              needsShortResolve: true,
              shortUrl: extractedUrl,
              platformHint: 'douyu',
              suggestedName,
              reason: '正在解析斗鱼专题直播间...',
            };
          } else if (
            first &&
            !['directory', 'pages', 'cms', 'search', 'member', 'follow'].includes(first)
          ) {
            roomId = segments[0];
          }
        }

        if (!roomId) {
          return {
            ok: true,
            platform: 'web',
            roomId: buildWebRoomId(extractedUrl),
            url: extractedUrl,
            suggestedName: suggestedName || '斗鱼网页',
          };
        }
        return {
          ok: true,
          platform: 'douyu',
          roomId,
          url: buildCanonicalUrl('douyu', roomId),
          suggestedName,
        };
      }

      if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
        return {
          ok: false,
          needsPlatform: false,
          needsShortResolve: true,
          shortUrl: extractedUrl,
          platformHint: 'bilibili',
          suggestedName,
          reason: '正在解析B站短链接...',
        };
      }

      if (host.includes('live.bilibili.com')) {
        const first = (segments[0] || '').toLowerCase();
        const roomId = first === 'blanc' || first === 'h5' ? segments[1] : segments[0];
        if (!roomId || !/^\d+$/.test(roomId)) {
          return {
            ok: true,
            platform: 'web',
            roomId: buildWebRoomId(extractedUrl),
            url: extractedUrl,
            suggestedName: suggestedName || 'B站直播广场',
          };
        }
        return {
          ok: true,
          platform: 'bilibili',
          roomId,
          url: buildCanonicalUrl('bilibili', roomId),
          suggestedName,
        };
      }

      // Main Bilibili site (www.bilibili.com, m.bilibili.com, space.bilibili.com, videos, etc.) -> free web!
      if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
        return {
          ok: true,
          platform: 'web',
          roomId: buildWebRoomId(extractedUrl),
          url: extractedUrl,
          suggestedName: suggestedName || suggestWebSiteName(extractedUrl),
        };
      }

      // Douyin short links & mobile reflow links (v.douyin.com, iesdouyin.com, webcast.amemv.com)
      if (
        host === 'v.douyin.com' ||
        host.endsWith('.v.douyin.com') ||
        host.includes('iesdouyin.com') ||
        host.includes('webcast.amemv.com')
      ) {
        return {
          ok: false,
          needsPlatform: false,
          needsShortResolve: true,
          shortUrl: extractedUrl,
          platformHint: 'douyin',
          suggestedName,
          reason: '正在解析抖音分享短链...',
        };
      }

      // Douyin Web URLs:
      // - live.douyin.com/{id} or www.douyin.com/follow/live/{id} or /root/live/{id} or /live/{id} -> Douyin Live
      // - www.douyin.com (main feed, /video/..., /discover, /jingxuan, /user/..., etc.) -> Free Web!
      if (host.includes('douyin.com')) {
        const queryRoomId =
          parsed.searchParams.get('web_rid') ||
          parsed.searchParams.get('room_id') ||
          parsed.searchParams.get('roomId');

        if (host.includes('live.douyin.com')) {
          if (segments[0] === 'webcast' && segments[1] === 'reflow' && segments[2]) {
            return {
              ok: false,
              needsPlatform: false,
              needsShortResolve: true,
              shortUrl: extractedUrl,
              platformHint: 'douyin',
              reason: '正在解析抖音直播间地址...',
            };
          }
          const roomId = segments[0] || queryRoomId || 'home';
          return {
            ok: true,
            platform: 'douyin',
            roomId,
            url: buildCanonicalUrl('douyin', roomId),
            suggestedName: roomId === 'home' ? suggestedName || '抖音直播广场' : suggestedName,
          };
        }

        const liveIdx = segments.indexOf('live');
        if (liveIdx !== -1 && segments[liveIdx + 1]) {
          const roomId = segments[liveIdx + 1];
          return {
            ok: true,
            platform: 'douyin',
            roomId,
            url: buildCanonicalUrl('douyin', roomId),
            suggestedName,
          };
        }
        if (queryRoomId) {
          return {
            ok: true,
            platform: 'douyin',
            roomId: queryRoomId,
            url: buildCanonicalUrl('douyin', queryRoomId),
            suggestedName,
          };
        }

        // Main Douyin site / short videos / discover / creator pages -> free web
        return {
          ok: true,
          platform: 'web',
          roomId: buildWebRoomId(extractedUrl),
          url: extractedUrl,
          suggestedName: suggestedName || suggestWebSiteName(extractedUrl),
        };
      }

      // Any other valid HTTP(S) website -> free web!
      return {
        ok: true,
        platform: 'web',
        roomId: buildWebRoomId(extractedUrl),
        url: extractedUrl,
        suggestedName: suggestedName || suggestWebSiteName(extractedUrl),
      };
    } catch {
      return { ok: false, needsPlatform: false, reason: '链接格式无效' };
    }
  }

  // 3. Bare room ID (allow dots for Douyin custom IDs)
  if (/^[a-zA-Z0-9_.-]{1,40}$/.test(trimmed)) {
    if (fallbackPlatform && isLivePlatform(fallbackPlatform)) {
      return {
        ok: true,
        platform: fallbackPlatform,
        roomId: trimmed,
        url: buildCanonicalUrl(fallbackPlatform, trimmed),
        suggestedName,
      };
    }
    return {
      ok: false,
      needsPlatform: true,
      roomId: trimmed,
      suggestedName,
      reason: '检测到纯房间号，请点击下方对应平台按钮添加',
    };
  }

  return { ok: false, needsPlatform: false, reason: '无法识别的链接或房间号' };
}

export function detectPlatformFromUrl(url: string): PlatformId | null {
  const lower = url.toLowerCase();
  if (lower.includes('huya.com')) return 'huya';
  if (lower.includes('douyu.com')) return 'douyu';
  if (lower.includes('bilibili.com')) return 'bilibili';
  if (lower.includes('douyin.com') || lower.includes('iesdouyin.com') || lower.includes('amemv.com')) {
    return 'douyin';
  }
  return null;
}

export const SAMPLE_CHANNELS: Channel[] = [
  {
    id: 'sample-huya-lpl',
    platform: 'huya',
    roomId: '660000',
    name: '虎牙英雄联盟官方 (660000)',
    group: 'LOL',
    url: 'https://www.huya.com/660000',
    pinned: false,
    createdAt: 1,
  },
  {
    id: 'sample-douyu-lpl',
    platform: 'douyu',
    roomId: '288016',
    name: '斗鱼英雄联盟官方 (288016)',
    group: 'LOL',
    url: 'https://www.douyu.com/288016',
    pinned: false,
    createdAt: 2,
  },
  {
    id: 'sample-bili-lpl',
    platform: 'bilibili',
    roomId: '6',
    name: 'B站英雄联盟赛事 (6)',
    group: 'LOL',
    url: 'https://live.bilibili.com/6',
    pinned: false,
    createdAt: 3,
  },
  {
    id: 'sample-douyin-home',
    platform: 'douyin',
    roomId: 'home',
    name: '抖音直播广场',
    group: '综合',
    url: 'https://live.douyin.com',
    pinned: false,
    createdAt: 4,
  },
];
