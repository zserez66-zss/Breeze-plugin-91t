/**
 * 91tutu.cc 站点抓取与解析层。
 *
 * 站点结构（已实测确认）：
 * - 详情页：`/posts/<slug>/`，slug 为"作者+标题"英译后**去除点号**生成，不可逆推，必须从列表 HTML 取 href 原值。
 * - 列表页：`/`、`/page/<n>/`、`/category/<R18|R17|R16>/<n>/`、`/scale/<healthy|borderline|explicit>/<n>/`
 * - 详情页内联给出全部内容图：`https://image.91tutu.cc/image/<中文图片目录>/ShyPetal.com@<同名目录>-001.webp` 递增
 * - 图片无防盗链，直连可取。
 * - 搜索是 Pagefind 客户端 WASM，插件不可用，因此不提供关键词搜索。
 */
import type { StringMap } from "breeze-plugin-kit";
import { cache } from "breeze-plugin-kit";
import { IMAGE_ORIGIN, SITE_ORIGIN, sanitizePathSegment } from "./common";

/** 统一的 UA，避免被 Cloudflare 判定为默认工具链 */
const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/** 抓取超时 */
const DEFAULT_TIMEOUT = 30000;

export type RawRequestOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
};

/** 抓取 HTML 文本 */
export async function fetchHtml(url: string, options: RawRequestOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(options.headers ?? {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`请求失败 ${res.status} ${res.statusText}: ${url}`);
  }
  return await res.text();
}

/** 站点相对/绝对路径统一成绝对 URL */
export function absoluteUrl(href: string): string {
  const value = String(href ?? "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${SITE_ORIGIN}${value}`;
  return `${SITE_ORIGIN}/${value}`;
}

// ---------------------------------------------------------------------------
// 列表页解析
// ---------------------------------------------------------------------------

/** 一个列表条目 */
export type ListEntry = {
  /** 详情页绝对 URL，用作 comicId */
  url: string;
  /** 站点 slug，如 `jiu-qu-jean-no117-2026sheng-ri` */
  slug: string;
  /** 完整标题，如 `九曲Jean - No.117 2026生日 [40P,6V-901MB]` */
  title: string;
  /** 封面图 URL（列表页给的 image.91tutu.cc/<slug>/cover.webp） */
  coverUrl: string;
};

/** 站点 slug 白名单过滤：只认 `/posts/<slug>/` */
export function toPostSlug(href: string): string {
  const abs = absoluteUrl(href);
  const m = abs.match(/^https?:\/\/(?:www\.)?91tutu\.cc\/posts\/([^/?#]+)\/?$/i);
  return m ? m[1] : "";
}

/**
 * 解析列表页，抽取全部帖子卡片。
 *
 * 页面是 Astro 静态生成的卡片结构：
 * `<div class="card relative min-h-[500px]"><a href="/posts/<slug>/">...<img src="..." alt="<完整标题>">`
 *
 * 这里用 DOM 选择器取 `<a href^="/posts/">`，再回溯找内部 img，
 * 比正则更稳（标题里含 `[`、`]`、`,`、空格等字符）。
 */
export function parseListPage(html: string): ListEntry[] {
  const domEntries = parseListPageByDom(html);
  if (domEntries.length > 0) return domEntries;
  // 宿主未注入 BreezeHtml（旧版运行时）时退回正则抽取，保证列表可用
  return parseListPageByRegex(html);
}

/** DOM 通道：依赖宿主注入的 BreezeHtml，精度最高 */
function parseListPageByDom(html: string): ListEntry[] {
  const out: ListEntry[] = [];
  const seen = new Set<string>();

  let $: ReturnType<typeof BreezeHtml.load>;
  try {
    $ = BreezeHtml.load(html);
  } catch {
    return out;
  }

  $('a[href*="/posts/"]').each((_i, el) => {
    const href = el.attr("href") ?? "";
    const slug = toPostSlug(href);
    if (!slug || seen.has(slug)) return;

    // 卡片里通常只有一个 img；优先取 alt 作为标题，取不到就退回 slug
    const img = el.find("img").first();
    const alt = (img.attr("alt") ?? "").trim();
    const src = (img.attr("src") ?? "").trim();

    // 有些卡片会把 src 放在 srcset 里，兜底再找一次
    const fallbackSrc = (img.attr("data-src") ?? "").trim();

    seen.add(slug);
    out.push({
      url: absoluteUrl(`/posts/${slug}/`),
      slug,
      title: alt || slug,
      coverUrl: absoluteUrl(src || fallbackSrc),
    });
  });

  return out;
}

/**
 * 正则通道：不依赖 BreezeHtml，纯字符串扫描。
 *
 * 匹配 <a href="/posts/<slug>/"> ... <img ...> 的卡片窗口，从 img 里取
 * alt 作为标题、src 作为封面。惰性匹配限制在同一个锚点内，避免跨卡片串标题。
 */
function parseListPageByRegex(html: string): ListEntry[] {
  const out: ListEntry[] = [];
  const seen = new Set<string>();
  // 引号字符类用 charCode 拼出来，避免源码里出现转义引号
  const DQ = String.fromCharCode(34);
  const SQ = String.fromCharCode(39);
  const QCH = "[" + DQ + SQ + "]";
  const QNEG = "[^" + DQ + SQ + "/?#]+";
  const attrRe = (name: string) =>
    new RegExp("\\b" + name + "=" + QCH + "([^" + DQ + SQ + "]*)" + QCH, "i");

  // 卡片锚点：<a href="/posts/<slug>/"> ... </a>
  const anchorRe = new RegExp(
    "<a\\b[^>]*?href=" + QCH +
      "(?:https?:\\/\\/(?:www\\.)?91tutu\\.cc)?\\/posts\\/(" + QNEG + ")\\/?" + QCH +
      "[^>]*>([\\s\\S]{0,6000}?)<\\/a>",
    "gi",
  );
  // 卡片内标题兜底：<h3 class="card-title">...</h3>
  const h3Re = /<h3\b[^>]*class=[^\u003e]*card-title[^\u003e]*>([\s\S]*?)<\/h3>/i;

  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    const inner = m[2] || m[0] || "";
    let alt = "";
    let src = "";

    // 1) 优先 <img alt/src>
    const im = inner.match(/<img\b([^>]*)>/i);
    if (im) {
      const attrs = im[1] || "";
      const am = attrs.match(attrRe("alt"));
      if (am) alt = am[1];
      const sm = attrs.match(attrRe("src")) || attrs.match(attrRe("data-src"));
      if (sm) src = sm[1];
      if (!src) {
        const ssm = attrs.match(/srcset=\s*[\u0027\u0022]?([^\s,\u0027\u0022]+)/i);
        if (ssm) src = ssm[1];
      }
    }

    // 2) 无 img 时看 <source srcset="...">（<picture> 模板）
    if (!src) {
      const srcTag = inner.match(/<source\b([^>]*)>/i);
      if (srcTag) {
        const ssm = (srcTag[1] || "").match(/srcset=\s*[\u0027\u0022]?([^\s,\u0027\u0022]+)/i);
        if (ssm) src = ssm[1];
      }
    }

    // 3) 标题兜底：<h3 class="card-title">文本</h3>
    if (!alt) {
      const hm = inner.match(h3Re);
      if (hm) {
        alt = (hm[1] || "")
          .replace(/<[^>]*>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, DQ)
          .replace(/&#39;/g, SQ)
          .replace(/&nbsp;/g, " ")
          .trim();
      }
    }

    seen.add(slug);
    out.push({
      url: absoluteUrl("/posts/" + slug + "/"),
      slug,
      title: (alt || "").trim() || slug,
      coverUrl: absoluteUrl((src || "").trim()),
    });
  }
  return out;
}
/** 从列表页 HTML 里推断当前页是否有下一页 */
export function hasNextPage(html: string, currentPage: number): boolean {
  // Astro 分页组件会渲染 `?page=` 或 `/page/<n>/` 链接；也检查"下一页"文案
  const nextPage = currentPage + 1;
  if (html.includes(`/page/${nextPage}/`)) return true;
  if (html.includes(`/page/${nextPage}"`)) return true;
  if (html.includes(`page=${nextPage}`)) return true;
  // 若当前页还能解析到条目，按"未到底"处理，交由条目数兜底
  return false;
}

// ---------------------------------------------------------------------------
// 列表页 URL 构造
// ---------------------------------------------------------------------------

/** 支持的浏览场景 */
export type BrowseKind = "latest" | "category" | "scale" | "tag";

export type BrowseQuery = {
  kind: BrowseKind;
  /** category: R18/R17/R16；scale: healthy/borderline/explicit；tag: 标签名 */
  value?: string;
  page: number;
};

/** 构造列表页 URL */
export function buildListUrl(query: BrowseQuery): string {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const value = String(query.value ?? "").trim();

  switch (query.kind) {
    case "category":
      return `${SITE_ORIGIN}/category/${encodeURIComponent(value || "R18")}/${page}/`;
    case "scale":
      return `${SITE_ORIGIN}/scale/${encodeURIComponent(value || "healthy")}/${page}/`;
    case "tag":
      return `${SITE_ORIGIN}/tags/${encodeURIComponent(value)}/${page}/`;
    case "latest":
    default:
      return page <= 1 ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/page/${page}/`;
  }
}

// ---------------------------------------------------------------------------
// 详情页解析
// ---------------------------------------------------------------------------

export type DetailData = {
  /** 完整标题（h1） */
  title: string;
  /** meta description 文本 */
  description: string;
  /** 作者名，从标题 "作者 - 作品 [NNP,NNV-XXXMB]" 里拆出来 */
  author: string;
  /** 图片数量（标题里的 NNP），解析不到为 0 */
  pageCount: number;
  /** 内容图绝对 URL 列表（按序号排序） */
  images: string[];
  /** 图片所在目录名（中文完整标题，用于本地路径与文件名） */
  imageDir: string;
  /** 相关推荐条目 */
  related: ListEntry[];
  /** 原始 HTML，供详情页二次解析使用 */
  html: string;
};

/** 从标题里拆作者与图片数：`九曲Jean - No.117 2026生日 [40P,6V-901MB]` */
function parseTitleMeta(title: string): { author: string; pageCount: number } {
  const t = String(title ?? "").trim();
  const author = (t.split(/\s+-\s+/)[0] ?? "").trim();
  const m = t.match(/\[(\d+)\s*P/i);
  return { author, pageCount: m ? Number(m[1]) : 0 };
}

/** 判断一张图是否是内容图（排除封面、相关推荐、站内 logo 等） */
function isContentImage(src: string): boolean {
  if (!src) return false;
  if (!/^https?:\/\/image\.91tutu\.cc\//i.test(src)) return false;
  const lower = src.toLowerCase();
  if (lower.includes("/cover.")) return false;
  if (lower.includes("shypetal.com@")) return true;
  // 兜底：目录下 -NNN.webp 形式
  return /-\d{3}\.(webp|jpe?g|png|avif)$/i.test(lower);
}

/** 从 URL 里抽图片序号，用于排序 */
function imageOrder(url: string): number {
  const m = url.match(/-(\d{1,4})\.(?:webp|jpe?g|png|avif)$/i);
  return m ? Number(m[1]) : 0;
}

/** 从内容图 URL 反推图片目录名 */
function extractImageDir(images: string[]): string {
  if (images.length === 0) return "";
  const m = images[0].match(/^https?:\/\/image\.91tutu\.cc\/image\/([^/]+)\//i);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** 解析详情页 HTML */
function decodeEntities(t: string): string {
  const AMP = String.fromCharCode(38);
  const QUOT = String.fromCharCode(34);
  const APOS = String.fromCharCode(39);
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  return t
    .split(AMP + "amp;").join(AMP)
    .split(AMP + "lt;").join(LT)
    .split(AMP + "gt;").join(GT)
    .split(AMP + "quot;").join(QUOT)
    .split(AMP + "#39;").join(APOS)
    .split(AMP + "nbsp;").join(String.fromCharCode(32));
}
function cleanSiteTitle(t: string): string {
  let x = t;
  // 剥离站点后缀，如 "-91tutu.cc-在线看Cosplay|R18写真"
  x = x.replace(/[-_|]?\s*91tutu\.cc[\s\S]*$/i, "");
  x = x.replace(/[-_|]?\s*91\u56fe\u56fe[\s\S]*$/i, "");
  x = x.replace(/[-_|]\s*\u5728\u7ebf\u770b[\s\S]*$/i, "");
  return x.trim();
}
function regexTitle(html: string): string {
  const patterns = [
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const text = cleanSiteTitle(decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim());
    if (text) return text;
  }
  return "";
}
/** 从详情页 HTML 用正则提取描述（不依赖 BreezeHtml） */
function regexDescription(html: string): string {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const text = decodeEntities(m[1]).trim();
    if (text) return text;
  }
  return "";
}
export function parseDetailPage(html: string, fallbackTitle = ""): DetailData {
  let images: string[] = [];
  let h1Title = "";
  let description = "";
  const related: ListEntry[] = [];

  let $: ReturnType<typeof BreezeHtml.load> | null = null;
  try {
    $ = BreezeHtml.load(html);
  } catch {
    $ = null;
  }

  if ($) {
    // 标题：优先 h1，退回 og:title，再退回 <title>
    h1Title = ($("h1").first().text() ?? "").trim();
    if (!h1Title) {
      h1Title = ($('meta[property="og:title"]').attr("content") ?? "").trim();
    }
    if (!h1Title) {
      h1Title = ($("title").first().text() ?? "").trim();
    }

    description = ($('meta[name="description"]').attr("content") ?? "").trim();

    // 内容图：收集所有 img，过滤封面与非内容图，去重后按序号排序
    const seen = new Set<string>();
    $("img").each((_i, el) => {
      const candidates = [
        (el.attr("src") ?? "").trim(),
        (el.attr("data-src") ?? "").trim(),
      ];
      for (const raw of candidates) {
        if (!raw) continue;
        const abs = absoluteUrl(raw);
        if (!isContentImage(abs)) continue;
        const key = abs.replace(/[?#].*$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(key);
      }
    });

    // 相关推荐：详情页底部也有帖子卡片
    const relSeen = new Set<string>();
    $('a[href*="/posts/"]').each((_i, el) => {
      const href = el.attr("href") ?? "";
      const slug = toPostSlug(href);
      if (!slug || relSeen.has(slug)) return;
      relSeen.add(slug);
      const img = el.find("img").first();
      related.push({
        url: absoluteUrl(`/posts/${slug}/`),
        slug,
        title: (img.attr("alt") ?? "").trim() || slug,
        coverUrl: absoluteUrl((img.attr("src") ?? "").trim()),
      });
    });
  }

  // 标题与描述的正则兜底：宿主未注入 BreezeHtml 时仍能取到
  if (!h1Title) h1Title = regexTitle(html);
  if (!description) description = regexDescription(html);

  // 正则兜底：BreezeHtml 选择器如有边角情况，直接用正则再捞一遍内容图
  if (images.length === 0) {
    const re = /https?:\/\/image\.91tutu\.cc\/image\/[^"'\s\\]+?-\d{3}\.(?:webp|jpe?g|png|avif)/gi;
    const found = html.match(re) ?? [];
    const seen = new Set<string>();
    for (const raw of found) {
      const key = absoluteUrl(raw).replace(/[?#].*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      images.push(key);
    }
  }

  images = images.sort((a, b) => imageOrder(a) - imageOrder(b));

  const title = h1Title || fallbackTitle;
  const { author, pageCount } = parseTitleMeta(title);

  return {
    title,
    description,
    author,
    pageCount,
    images,
    imageDir: extractImageDir(images),
    related: related.slice(0, 12),
    html,
  };
}

/** 抓取并解析详情页，带进程内缓存 */
export async function loadDetail(comicId: string, timeoutMs = DEFAULT_TIMEOUT): Promise<DetailData> {
  const url = normalizeComicUrl(comicId);
  const cacheKey = `91tutu:detail:${url}`;
  // 缓存读写单独兜底: 宿主未注入 cache 时不能影响详情页加载
  try {
    const cached = await cache.get<DetailData | null>(cacheKey, null);
    if (cached) return cached;
  } catch {
    // 忽略缓存读取失败, 继续走网络抓取
  }

  const html = await fetchHtml(url, { timeoutMs });
  const detail = parseDetailPage(html);

  if (detail.images.length === 0 && detail.title === "") {
    throw new Error("详情页解析失败：页面可能已下架或站点结构变更");
  }

  try {
    await cache.set(cacheKey, detail);
  } catch {
    // 写缓存失败不影响本次返回
  }
  return detail;
}

/**
 * 把用户/宿主给的 comicId 归一化成可请求的绝对 URL。
 *
 * comicId 约定为 `/posts/<slug>/`。为兼容直接粘贴整串 URL 的情况，这里做兜底：
 * - 已是 http(s) 开头 → 直接用
 * - 以 `/` 开头 → 拼站点
 * - 只给了 slug → 拼 `/posts/<slug>/`
 */
export function normalizeComicUrl(comicId: string): string {
  const raw = String(comicId ?? "").trim();
  if (!raw) throw new Error("comicId 不能为空");

  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${SITE_ORIGIN}${raw}`;
  return `${SITE_ORIGIN}/posts/${raw.replace(/^\/+|\/+$/g, "")}/`;
}

/** 从 comicId 里抽 slug，用于本地文件路径 */
export function slugFromComicId(comicId: string): string {
  const m = String(comicId ?? "").match(/\/posts\/([^/?#]+)/i);
  return sanitizePathSegment(m ? m[1] : comicId);
}

// ---------------------------------------------------------------------------
// 章节 / 图片构造
// ---------------------------------------------------------------------------

/** 每章最多塞多少张图（宿主单章图片过多会拖慢列表渲染，这里切片） */
export const IMAGES_PER_CHAPTER = 200;

export type ChapterSlice = {
  id: string;
  requestId: string;
  logicalKey: string;
  storageChapterId: string;
  name: string;
  order: number;
  from: number;
  to: number;
  extern: StringMap;
};

/**
 * 把图片切成章节。
 * 一个套图就是"一章"，若超过 IMAGES_PER_CHAPTER 则继续切片，避免单章过大。
 */
export function buildChapters(comicId: string, total: number): ChapterSlice[] {
  const slug = slugFromComicId(comicId);
  const safeTotal = Math.max(0, Math.floor(total));
  if (safeTotal === 0) return [];

  const chunks: ChapterSlice[] = [];
  let order = 1;
  for (let from = 0; from < safeTotal; from += IMAGES_PER_CHAPTER) {
    const to = Math.min(safeTotal, from + IMAGES_PER_CHAPTER);
    const id = safeTotal <= IMAGES_PER_CHAPTER ? "full" : `part-${order}`;
    const name =
      safeTotal <= IMAGES_PER_CHAPTER
        ? "全集"
        : `第${order}部分（${from + 1}-${to}）`;
    chunks.push({
      id,
      requestId: id,
      logicalKey: id,
      storageChapterId: `${slug}-${id}`,
      name,
      order,
      from,
      to,
      extern: {},
    });
    order += 1;
  }
  return chunks;
}

/** 一张图的下载描述 */
export type PageRef = {
  id: string;
  name: string;
  path: string;
  url: string;
  extern: StringMap;
};

/** 由图片 URL 推断文件名 */
export function fileNameFromUrl(url: string, index: number): string {
  const clean = String(url ?? "").replace(/[?#].*$/, "");
  const base = clean.split("/").pop() ?? "";
  // 内容图名字自带 `ShyPetal.com@` 前缀且很长，本地落盘时改成短名，避免路径超长
  const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] ?? "webp").toLowerCase();
  return `${String(index + 1).padStart(3, "0")}.${ext}`;
}

/**
 * 把图片链接转成 PageRef 列表。
 *
 * 本地落盘路径刻意只用 ASCII（slug + 序号），不使用中文目录名，
 * 否则在部分 Android 文件系统 / 压缩包里会出现编码问题。
 */
export function buildPages(
  comicId: string,
  chapter: ChapterSlice,
  images: string[],
): PageRef[] {
  const slug = slugFromComicId(comicId);
  const pages: PageRef[] = [];
  for (let i = chapter.from; i < chapter.to && i < images.length; i += 1) {
    const url = images[i];
    const name = fileNameFromUrl(url, i);
    pages.push({
      id: `${chapter.id}-${i}`,
      name,
      path: `91tutu/${slug}/${chapter.id}/${name}`,
      url,
      extern: {},
    });
  }
  return pages;
}

/** 取图片文件名的存储路径（宿主用它做磁盘缓存 key） */
export function coverPathFor(comicId: string): string {
  return `91tutu/${slugFromComicId(comicId)}/cover.webp`;
}

/** 图片主机上的封面直链（列表页已给，兜底用 slug 拼） */
export function coverUrlFallback(slug: string): string {
  return `${IMAGE_ORIGIN}/image/${encodeURIComponent(slug)}/cover.webp`;
}

// ---------------------------------------------------------------------------
// 尺度分类（scale）—— 走 JSON 接口
// ---------------------------------------------------------------------------
//
// 站点实测结论（务必保留，避免后来者重走弯路）：
// 1) `/scale/<explicit|healthy|borderline>/<n>/` 的 HTML 里**没有任何 `/posts/` 链接**，
//    只有“加载中…”占位 + 空的 `#scale-posts-grid`，靠客户端 JS 渲染。
//    → 因此**不能**走 parseListPage，现实现下会返回 0 条。
// 2) 真正的数据接口是 `/api/scale-list/?scale=<X>&page=<n>&pageSize=<m>`，
//    返回 `{ slugs: string[], pagination: { page, pageSize, totalItems, totalPages, hasMore } }`。
// 3) 接口只给 slug **不给标题/封面**。标题与封面需要从 scale 页内联的
//    `const postsJson = "..."` 取：那是一份**全站 1857 条**的元数据索引
//    （字段：slug/title/cover/coverAlt/tags/pubDate/category/description），
//    且 explicit / healthy / borderline 三个页面的该段内容 MD5 完全一致，可直接互相复用。
// 4) `image.91tutu.cc/image/<slug>/cover.webp` 是 **404**（封面目录名≠slug），
//    所以封面必须用 postsJson 里的 `cover` 原值，不可自己拼。

/** scale 页内联索引的一条记录 */
export type PostsIndexEntry = {
  slug: string;
  title: string;
  cover: string;
  coverAlt: string;
  tags: string[];
  pubDate: string;
  category: string[];
  description: string;
};

/** 内联索引的进程内缓存 key */
const POSTS_INDEX_CACHE_KEY = "91tutu:posts-index:v1";
/** 索引缓存有效期：全站索引变化极慢，缓存 6 小时 */
const POSTS_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
/** scale 列表每页条数（接口支持任意值，取 24 与首页卡片密度接近） */
const SCALE_PAGE_SIZE = 24;


/** scale 页面 URL（只用来取内联索引，不用于解析列表） */
export function buildScaleIndexUrl(value: string): string {
  const v = String(value ?? "").trim() || "explicit";
  return `${SITE_ORIGIN}/scale/${encodeURIComponent(v)}/1/`;
}

/** 构造 scale JSON 接口 URL */
export function buildScaleApiUrl(value: string, page: number, pageSize = 24): string {
  const v = String(value ?? "").trim() || "explicit";
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.max(1, Math.floor(Number(pageSize) || 24));
  return `${SITE_ORIGIN}/api/scale-list/?scale=${encodeURIComponent(v)}&page=${p}&pageSize=${size}`;
}

/**
 * 从 scale 页 HTML 中抽出 `const postsJson = "<转义后的 JSON>";` 并还原成数组。
 * 该值是"JSON 字符串的再一层转义"，需要两次 JSON.parse。
 */
export function parsePostsIndex(html: string): PostsIndexEntry[] {
  const marker = 'const postsJson = "';
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const begin = start + marker.length;
  // 向后找未转义的双引号作为结束（转义引号写作 \\" ）
  let end = begin;
  while (end < html.length) {
    if (html[end] === '"' && html[end - 1] !== "\\") break;
    end += 1;
  }
  if (end >= html.length) return [];
  const raw = html.slice(begin, end);
  let parsed: unknown;
  try {
    // 第一层：把转义串还原成真正的 JSON 文本
    parsed = JSON.parse(`"${raw}"`);
  } catch {
    return [];
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: PostsIndexEntry[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const slug = String(r.slug ?? "").trim();
    if (!slug) continue;
    const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
    const catRaw = Array.isArray(r.category) ? r.category : [];
    out.push({
      slug,
      title: String(r.title ?? "").trim() || slug,
      cover: String(r.cover ?? "").trim(),
      coverAlt: String(r.coverAlt ?? "").trim(),
      tags: tagsRaw.map((t) => String(t ?? "").trim()).filter(Boolean),
      pubDate: String(r.pubDate ?? "").trim(),
      category: catRaw.map((c) => String(c ?? "").trim()).filter(Boolean),
      description: String(r.description ?? "").trim(),
    });
  }
  return out;
}

/** 加载全站元数据索引（带缓存）。抓不到就返回空数组，由调用方降级。 */
export async function loadPostsIndex(timeoutMs = DEFAULT_TIMEOUT): Promise<PostsIndexEntry[]> {
  // 缓存读写单独兜底：宿主未注入 cache 或存储异常时不能影响索引抓取
  try {
    const cached = await cache.get<{ at: number; list: PostsIndexEntry[] } | null>(
      POSTS_INDEX_CACHE_KEY,
      null,
    );
    if (cached && Array.isArray(cached.list) && cached.list.length > 0) {
      const age = Date.now() - Number(cached.at ?? 0);
      if (age >= 0 && age < POSTS_INDEX_TTL_MS) return cached.list;
    }
  } catch {
    // 忽略缓存读取失败，继续走网络抓取
  }
  // 三个尺度页面的内联索引完全一致，用 explicit 作默认抓取入口即可
  const html = await fetchHtml(buildScaleIndexUrl("explicit"), { timeoutMs });
  const list = parsePostsIndex(html);
  if (list.length > 0) {
    try {
      await cache.set(POSTS_INDEX_CACHE_KEY, { at: Date.now(), list });
    } catch {
      // 写缓存失败不影响本次返回
    }
  }
  return list;
}

/** scale JSON 接口响应 */
export type ScaleListResponse = {
  slugs: string[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasMore: boolean;
  };
};

/** 解析 scale JSON 接口响应 */
export function parseScaleListJson(text: string): ScaleListResponse {
  const empty: ScaleListResponse = {
    slugs: [],
    pagination: { page: 1, pageSize: 0, totalItems: 0, totalPages: 0, hasMore: false },
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!data || typeof data !== "object") return empty;
  const d = data as Record<string, unknown>;
  const slugsRaw = Array.isArray(d.slugs) ? d.slugs : [];
  const slugs = slugsRaw.map((s) => String(s ?? "").trim()).filter(Boolean);
  const pg = (d.pagination && typeof d.pagination === "object" ? d.pagination : {}) as Record<
    string,
    unknown
  >;
  const num = (v: unknown, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    slugs,
    pagination: {
      page: num(pg.page, 1),
      pageSize: num(pg.pageSize, slugs.length),
      totalItems: num(pg.totalItems, slugs.length),
      totalPages: num(pg.totalPages, 1),
      hasMore: pg.hasMore === true,
    },
  };
}

// ---------------------------------------------------------------------------
// 统一列表加载入口（HTML 列表 / scale JSON 接口）
// ---------------------------------------------------------------------------

/** 列表加载结果 */
export type ListPageResult = {
  entries: ListEntry[];
  hasReachedMax: boolean;
  total: number;
};

/**
 * 统一加载一页列表。
 *
 * - latest / category / tag：走 HTML 列表页，用 parseListPage + hasNextPage
 * - scale：走 /api/scale-list/ JSON 接口，再用全站元数据索引补齐标题与封面
 */
export async function loadListPage(
  query: BrowseQuery,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<ListPageResult> {
  if (query.kind === "scale") {
    return await loadScaleListPage(query, timeoutMs);
  }
  const url = buildListUrl(query);
  const html = await fetchHtml(url, { timeoutMs });
  const entries = parseListPage(html);
  return {
    entries,
    hasReachedMax: entries.length === 0 || !hasNextPage(html, query.page),
    total: entries.length,
  };
}

/** scale 专用：JSON 接口拿 slug 序 + 索引补元数据 */
async function loadScaleListPage(
  query: BrowseQuery,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<ListPageResult> {
  const scale = String(query.value ?? "").trim() || "explicit";
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const apiUrl = buildScaleApiUrl(scale, page, SCALE_PAGE_SIZE);
  const text = await fetchHtml(apiUrl, {
    timeoutMs,
    headers: { accept: "application/json, text/plain, */*" },
  });
  const data = parseScaleListJson(text);
  if (data.slugs.length === 0) {
    return { entries: [], hasReachedMax: true, total: 0 };
  }
  // 索引可能抓取失败（例如该页面改版），此时降级：标题用 slug，封面留空由宿主兜底
  let indexMap: Map<string, PostsIndexEntry> | null = null;
  try {
    const list = await loadPostsIndex(timeoutMs);
    if (list.length > 0) {
      indexMap = new Map<string, PostsIndexEntry>();
      for (const row of list) indexMap.set(row.slug, row);
    }
  } catch {
    indexMap = null;
  }
  const entries: ListEntry[] = data.slugs.map((slug) => {
    const hit = indexMap ? indexMap.get(slug) : undefined;
    return {
      url: absoluteUrl(`/posts/${slug}/`),
      slug,
      title: hit?.title || slug,
      coverUrl: hit?.cover || "",
    };
  });
  const hasReachedMax = !data.pagination.hasMore;
  return { entries, hasReachedMax, total: data.pagination.totalItems };
}
