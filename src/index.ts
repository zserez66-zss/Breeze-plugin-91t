import type {
  AdvancedSearchContract,
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPage,
  ChapterPayload,
  ChapterSummary,
  ComicDetailContract,
  ComicDetailNormal,
  ComicDetailPayload,
  ComicListItem,
  ComicPagedListContract,
  ComicListSceneBundleContract,
  CreatorPageAction,
  FetchImageBytesPayload,
  FilterBundleContract,
  FunctionPageContract,
  GetFunctionPagePayload,
  InfoContract,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingChangedPayload,
  SettingsBundleContract,
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import { cache, flutterTools, pluginConfig, runtime } from "breeze-plugin-kit";
import {
  PLUGIN_ID,
  createActionItem,
  createComicItem,
  createImage,
  createMetadataActionList,
  toStringMap,
} from "./common";
import { buildPluginInfo } from "./get-info";
import {
  IMAGES_PER_CHAPTER,
  buildChapters,
  buildPages,
  coverPathFor,
  coverUrlFallback,
  fetchHtml,
  loadDetail,
  loadListPage,
  normalizeComicUrl,
  slugFromComicId,
  toPostSlug,
  type BrowseQuery,
  type ChapterSlice,
  type DetailData,
} from "./site";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const CACHE_TTL_DETAIL_MS = 10 * 60 * 1000;

/** 读取布尔型插件设置（pluginConfig.load 返回双层 JSON 字符串） */
async function loadBool(key: string, fallback: boolean): Promise<boolean> {
  try {
    const raw = await pluginConfig.load(key, JSON.stringify({ value: fallback }));
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.value === "boolean" ? parsed.value : fallback;
  } catch {
    return fallback;
  }
}

/** 从 payload 中提取浏览查询条件（extern 优先，兼容 core） */
function readQuery(payload: SearchComicPayload | Record<string, unknown>): BrowseQuery {
  const extern = toStringMap((payload as SearchComicPayload).extern);
  const core = toStringMap((payload as Record<string, unknown>).core);

  // extern 里可能给 {kind, key}，也可能只给 {kind: "category:R18"}（高级筛选的 value）
  const kindRaw = String(extern.kind ?? core.kind ?? "latest").trim();
  const keyRaw = String(extern.key ?? core.key ?? extern.value ?? core.value ?? "").trim();

  let kind: BrowseQuery["kind"] = "latest";
  let value = keyRaw;

  const colon = kindRaw.indexOf(":");
  if (colon > 0) {
    const head = kindRaw.slice(0, colon);
    const tail = kindRaw.slice(colon + 1);
    if (head === "category" || head === "scale" || head === "tag") {
      kind = head;
      value = value || tail;
    }
  } else if (kindRaw === "category" || kindRaw === "scale" || kindRaw === "tag") {
    kind = kindRaw;
  }

  return {
    kind,
    value,
    page: Math.max(1, Number(extern.page ?? core.page ?? payload.page ?? 1) || 1),
  };
}

/** 把 DetailData 里的图片转成简介用的标签 */
function detailTags(detail: DetailData): string[] {
  const out: string[] = [];
  if (detail.author) out.push(detail.author);
  if (detail.pageCount > 0) out.push(`${detail.pageCount}P`);
  return out;
}

/** 把详情页解析结果转成列表项（用于相关推荐） */
function detailToItem(detail: DetailData, comicId: string): ComicListItem {
  return createComicItem({
    id: comicId,
    title: detail.title,
    subtitle: detail.author,
    coverUrl: detail.images.length > 0 ? detail.images[0] : coverUrlFallback(slugFromComicId(comicId)),
    coverPath: coverPathFor(comicId),
    tags: detailTags(detail),
    categories: [],
    authors: detail.author ? [detail.author] : [],
    extern: { path: comicId },
  });
}

/** 章节切分：把 DetailData 的图片按 IMAGES_PER_CHAPTER 切片 */
function chaptersOf(comicId: string, detail: DetailData): ChapterSlice[] {
  return buildChapters(comicId, detail.images.length);
}

/** 从章节切片生成 ChapterSummary */
function toChapterSummary(chapter: ChapterSlice): ChapterSummary {
  return {
    id: chapter.id,
    requestId: chapter.requestId,
    logicalKey: chapter.logicalKey,
    storageChapterId: chapter.storageChapterId,
    name: chapter.name,
    order: chapter.order,
    extern: chapter.extern,
  };
}

/** 根据 requestId / chapterId 找章节，找不到退回第一个 */
function resolveChapter(chapters: ChapterSlice[], input: unknown): ChapterSlice {
  const id = String(input ?? "").trim();
  return chapters.find((c) => c.requestId === id || c.id === id) ?? chapters[0];
}

/** 生成某章节的图片列表 */
function pagesOf(comicId: string, detail: DetailData, chapter: ChapterSlice): ChapterPage[] {
  return buildPages(comicId, chapter, detail.images).map((page) => ({
    id: page.id,
    name: page.name,
    path: page.path,
    url: page.url,
    extern: page.extern,
  }));
}

// ---------------------------------------------------------------------------
// init — 插件初始化
// ---------------------------------------------------------------------------

async function init(): Promise<{ source: string; data: { ok: boolean } }> {
  return { source: PLUGIN_ID, data: { ok: true } };
}

// ---------------------------------------------------------------------------
// getInfo
// ---------------------------------------------------------------------------

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

// ---------------------------------------------------------------------------
// searchComic — 站点无服务端搜索，退化为"标签/分类筛选"
// ---------------------------------------------------------------------------

async function searchComic(payload: SearchComicPayload = {}): Promise<SearchResultContract> {
  const query = readQuery(payload);
  const keyword = String(payload.keyword ?? query.value ?? "").trim();

  // 有关键词时按标签浏览；无关键词时退化为最新列表
  const effective: BrowseQuery = keyword
    ? { kind: "tag", value: keyword, page: query.page }
    : { kind: "latest", value: "", page: query.page };

  const pageResult = await loadListPage(effective);
  const entries = pageResult.entries;

  const items: ComicListItem[] = entries.map((entry) =>
    createComicItem({
      id: entry.url,
      title: entry.title,
      subtitle: "",
      coverUrl: entry.coverUrl,
      coverPath: coverPathFor(entry.url),
      tags: keyword ? [keyword] : [],
      categories: [],
      authors: [],
      extern: { path: entry.url, slug: entry.slug },
    }),
  );

  const hasReachedMax = entries.length === 0 || pageResult.hasReachedMax;
  const paging = {
    page: effective.page,
    pages: hasReachedMax ? effective.page : effective.page + 1,
    total: items.length,
    hasReachedMax,
  };

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0" as const,
      type: "searchResult" as const,
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { paging, items },
    paging,
    items,
  };
}

// ---------------------------------------------------------------------------
// getComicDetail
// ---------------------------------------------------------------------------

async function getComicDetail(payload: ComicDetailPayload = {}): Promise<ComicDetailContract> {
  const comicId = normalizeComicUrl(String(payload.comicId ?? "").trim());
  if (!comicId) throw new Error("comicId 不能为空");

  const detail = await loadDetail(comicId);
  const chapters = chaptersOf(comicId, detail);
  const slug = slugFromComicId(comicId);

  const allowAdult = await loadBool("content.adult", true);
  const allTags = detailTags(detail);
  const tags = allowAdult ? allTags : allTags.filter((t) => /^(R16|安全)$/i.test(t));

  const titleMeta = [createActionItem(`共 ${detail.images.length}P`)];
  if (detail.author) titleMeta.push(createActionItem(`作者：${detail.author}`));
  if (chapters.length > 1) titleMeta.push(createActionItem(`分 ${chapters.length} 章`));

  const metadata = [];
  if (detail.author) metadata.push(createMetadataActionList("author", "作者", [detail.author]));
  if (tags.length > 0) metadata.push(createMetadataActionList("tags", "标签", tags));
  metadata.push(createMetadataActionList("pages", "图片数", [`${detail.images.length}P`]));

  const normal: ComicDetailNormal = {
    comicInfo: {
      id: comicId,
      title: detail.title,
      titleMeta,
      creator: {
        id: detail.author || slug,
        name: detail.author || "未知作者",
        avatar: createImage({
          id: "creator",
          url: "",
          name: "avatar.webp",
          path: `91tutu/${slug}/avatar.webp`,
          extern: {},
        }),
        onTap: {} as CreatorPageAction,
        extern: {},
      },
      description: detail.description,
      cover: createImage({
        id: comicId,
        url: detail.images.length > 0 ? detail.images[0] : coverUrlFallback(slug),
        name: `${slug}.webp`,
        path: coverPathFor(comicId),
        extern: {},
      }),
      metadata,
      extern: { path: comicId, dir: detail.imageDir },
    },
    eps: chapters.map(toChapterSummary),
    recommend: detail.related.slice(0, 12).map((rel) => createComicItem({
      id: rel.url,
      title: rel.title,
      subtitle: "",
      coverUrl: rel.coverUrl,
      coverPath: coverPathFor(rel.url),
      tags: [],
      categories: [],
      authors: [],
      extern: { path: rel.url, slug: rel.slug },
    })),
    totalViews: 0,
    totalLikes: 0,
    totalComments: 0,
    isFavourite: false,
    isLiked: false,
    allowComments: false,
    allowCommentsReason: "91图图未开放评论接口",
    allowLike: false,
    allowLikeReason: "91图图不支持点赞",
    allowCollected: true,
    allowCollectedReason: "",
    allowDownload: true,
    allowDownloadReason: "",
    extern: {},
  };

  return {
    source: PLUGIN_ID,
    comicId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0" as const,
      type: "comicDetail" as const,
      source: PLUGIN_ID,
    },
    data: {
      normal,
      raw: {
        comicInfo: { id: comicId, title: detail.title, pageCount: detail.images.length },
        series: chapters.map(toChapterSummary),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// getChapter — 下载用
// ---------------------------------------------------------------------------

async function getChapter(payload: ChapterPayload = {}): Promise<ChapterContentContract> {
  const comicId = normalizeComicUrl(String(payload.comicId ?? "").trim());
  if (!comicId) throw new Error("comicId 不能为空");

  const detail = await loadDetail(comicId);
  const chapters = chaptersOf(comicId, detail);
  const chapter = resolveChapter(chapters, payload.chapterId);

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId: chapter.id,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0" as const,
      type: "chapterContent" as const,
      source: PLUGIN_ID,
    },
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: detail.title,
        extern: {},
      },
      chapter: {
        id: chapter.id,
        requestId: chapter.requestId,
        logicalKey: chapter.logicalKey,
        storageChapterId: chapter.storageChapterId,
        name: chapter.name,
        order: chapter.order,
        pages: pagesOf(comicId, detail, chapter),
        extern: chapter.extern,
      },
      chapters: chapters.map(toChapterSummary),
    },
  };
}

// ---------------------------------------------------------------------------
// getReadSnapshot — 在线阅读
// ---------------------------------------------------------------------------

async function getReadSnapshot(payload: ReadSnapshotPayload = {}): Promise<ReadSnapshotContract> {
  const comicId = normalizeComicUrl(String(payload.comicId ?? "").trim());
  if (!comicId) throw new Error("comicId 不能为空");

  const detail = await loadDetail(comicId);
  const chapters = chaptersOf(comicId, detail);
  const chapter = resolveChapter(chapters, payload.chapterId);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: detail.title,
        extern: { path: comicId },
      },
      chapter: {
        id: chapter.id,
        requestId: chapter.requestId,
        logicalKey: chapter.logicalKey,
        storageChapterId: chapter.storageChapterId,
        name: chapter.name,
        order: chapter.order,
        pages: pagesOf(comicId, detail, chapter),
        extern: chapter.extern,
      },
      chapters: chapters.map((c) => ({
        id: c.id,
        name: c.name,
        order: c.order,
        extern: c.extern,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// getDownloadConcurrency
// ---------------------------------------------------------------------------

async function getDownloadConcurrency(): Promise<{ concurrency: number }> {
  // 图片主机不校验防盗链，但 Cloudflare 对并发敏感，保守取 4
  return { concurrency: 4 };
}

// ---------------------------------------------------------------------------
// fetchImageBytes
// ---------------------------------------------------------------------------

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
  taskGroupKey = "",
}: FetchImageBytesPayload = {}): Promise<Uint8Array<ArrayBufferLike>> {
  const targetUrl = String(url).trim();
  if (!targetUrl) throw new Error("url 不能为空");

  if (taskGroupKey && (await runtime.isTaskGroupCancelled(taskGroupKey))) {
    return new Uint8Array(new ArrayBuffer(0));
  }

  const res = await fetch(targetUrl, {
    headers: {
      "x-rquickjs-host-offload-binary-v1": "1",
      "user-agent":
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      referer: "https://91tutu.cc/",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`下载失败: ${res.status} ${res.statusText}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 社交能力 — 站点不支持，全部安全降级
// ---------------------------------------------------------------------------

async function toggleLike(payload: { currentLiked?: boolean } = {}): Promise<{ liked: boolean }> {
  return { liked: !payload.currentLiked };
}

async function toggleFavorite(payload: {
  currentFavorite?: boolean;
} = {}): Promise<{ favorited: boolean; nextStep: string }> {
  return { favorited: !payload.currentFavorite, nextStep: "none" };
}

async function listFavoriteFolders(): Promise<{ items: { id: string; name: string }[] }> {
  return { items: [{ id: "default", name: "默认收藏夹" }] };
}

async function moveFavoriteToFolder(
  _payload: Record<string, unknown> = {},
): Promise<{ ok: boolean }> {
  return { ok: true };
}

async function getCommentFeed(
  _payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return { source: PLUGIN_ID, data: { items: [], hasReachedMax: true } };
}

async function loadCommentReplies(
  _payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return { source: PLUGIN_ID, data: { items: [], hasReachedMax: true } };
}

async function postComment(
  _payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  throw new Error("91图图不支持评论");
}

async function postCommentReply(
  _payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  throw new Error("91图图不支持评论");
}

// ---------------------------------------------------------------------------
// getAdvancedSearchScheme — 用分类/尺度代替关键词搜索
// ---------------------------------------------------------------------------

async function getAdvancedSearchScheme(
  _payload: Record<string, unknown> = {},
): Promise<AdvancedSearchContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "advancedSearch" as const,
      title: "91图图 · 筛选",
      fields: [
        {
          key: "kind",
          kind: "choice" as const,
          label: "浏览方式",
          options: [
            { label: "最新更新", value: "latest" },
            { label: "R18", value: "category:R18" },
            { label: "R17", value: "category:R17" },
            { label: "R16", value: "category:R16" },
            { label: "显式尺度", value: "scale:explicit" },
            { label: "健康尺度", value: "scale:healthy" },
          ],
        },
      ],
    },
    data: { values: { kind: "latest" } },
  };
}

// ---------------------------------------------------------------------------
// getComicListSceneBundle
// ---------------------------------------------------------------------------

async function getComicListSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "comicListSceneBundle" as const,
    },
    data: {
      scene: {
        title: "91图图",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList" as const,
          request: {
            fnPath: "getRankingData",
            core: {},
            extern: { kind: "latest" },
          },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          extern: { kind: "latest" },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// getRankingData — 真实列表抓取
// ---------------------------------------------------------------------------

async function getRankingData(payload: SearchComicPayload = {}): Promise<ComicPagedListContract> {
  const query = readQuery(payload);
  const pageResult = await loadListPage(query);
  const entries = pageResult.entries;

  const allowAdult = await loadBool("content.adult", true);

  let items: ComicListItem[] = entries.map((entry) =>
    createComicItem({
      id: entry.url,
      title: entry.title,
      subtitle: "",
      coverUrl: entry.coverUrl,
      coverPath: coverPathFor(entry.url),
      tags: [],
      categories: query.kind === "category" && query.value ? [query.value] : [],
      authors: [],
      extern: { path: entry.url, slug: entry.slug },
    }),
  );

  if (!allowAdult) {
    // 关闭成人内容时，R18 分区直接不下发内容
    items = query.kind === "category" && query.value === "R18" ? [] : items;
  }

  const hasReachedMax = entries.length === 0 || pageResult.hasReachedMax;

  return {
    source: PLUGIN_ID,
    extern: { kind: query.kind, key: query.value, page: String(query.page) },
    scheme: {
      version: "1.0.0" as const,
      type: "rankingFeed" as const,
    },
    data: {
      hasReachedMax,
      items,
    },
  };
}

// ---------------------------------------------------------------------------
// getRankingFilterBundle
// ---------------------------------------------------------------------------

async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      fields: [
        {
          key: "kind",
          kind: "choice" as const,
          label: "分区",
          options: [
            { label: "最新", value: "latest", result: { extern: { kind: "latest" } } },
            { label: "R18", value: "r18", result: { extern: { kind: "category", key: "R18" } } },
            { label: "R17", value: "r17", result: { extern: { kind: "category", key: "R17" } } },
            { label: "R16", value: "r16", result: { extern: { kind: "category", key: "R16" } } },
            {
              label: "显式",
              value: "explicit",
              result: { extern: { kind: "scale", key: "explicit" } },
            },
            {
              label: "边界",
              value: "borderline",
              result: { extern: { kind: "scale", key: "borderline" } },
            },
            {
              label: "健康",
              value: "healthy",
              result: { extern: { kind: "scale", key: "healthy" } },
            },
          ],
        },
      ],
    },
    data: { values: { kind: "latest" } },
  };
}

// ---------------------------------------------------------------------------
// settings / capabilities / userInfo
// ---------------------------------------------------------------------------

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "settings" as const,
      sections: [
        {
          title: "内容",
          fields: [
            {
              key: "content.adult",
              kind: "switch",
              label: "显示 R18 内容",
              fnPath: "onAdultChanged",
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      values: {
        "content.adult": true,
      },
    },
  };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "capabilities" as const,
      actions: [{ key: "clear", title: "清理插件缓存", fnPath: "clearPluginCache" }],
    },
    data: {},
  };
}

async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0" as const, type: "userInfo" as const },
    data: {
      title: "91图图",
      avatar: createImage({
        id: "logo",
        url: "",
        name: "logo.webp",
        path: "91tutu/logo.webp",
        extern: {},
      }),
      lines: ["图源：91tutu.cc", "无需登录", "支持原图打包下载"],
    },
  };
}

// ---------------------------------------------------------------------------
// getFunctionPage
// ---------------------------------------------------------------------------

async function getFunctionPage(
  payload: GetFunctionPagePayload = {},
): Promise<FunctionPageContract> {
  const extern = toStringMap((payload as unknown as { extern?: unknown }).extern);
  const kind = String(extern.kind ?? "latest");
  const key = String(extern.key ?? "");
  const titleMap: Record<string, string> = {
    latest: "最新更新",
    category: `分类 ${key || "全部"}`,
    scale: `尺度 ${key || "全部"}`,
    tag: `标签 ${key || "全部"}`,
  };
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "page" as const,
      title: titleMap[kind] ?? "91图图",
      body: { type: "list", children: [] },
    },
    data: { message: "请从插件首页或图源入口进入列表。" },
  };
}

// ---------------------------------------------------------------------------
// fnPath 回调
// ---------------------------------------------------------------------------

async function onAuthChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  await pluginConfig.save(payload.key, JSON.stringify({ value: payload.value }));
  return {};
}

async function onRememberChanged(
  payload: SettingChangedPayload<boolean> = { extern: {}, key: "", value: false },
): Promise<Record<string, unknown>> {
  await pluginConfig.save(payload.key, JSON.stringify({ value: payload.value }));
  return {};
}

async function onThemeChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  await pluginConfig.save(payload.key, JSON.stringify({ value: payload.value }));
  return {};
}

async function onQualityChanged(
  payload: SettingChangedPayload<string> = { extern: {}, key: "", value: "" },
): Promise<Record<string, unknown>> {
  await pluginConfig.save(payload.key, JSON.stringify({ value: payload.value }));
  return {};
}

async function onAdultChanged(
  payload: SettingChangedPayload<boolean> = { extern: {}, key: "", value: true },
): Promise<Record<string, unknown>> {
  await pluginConfig.save(payload.key, JSON.stringify({ value: payload.value }));
  await flutterTools.showToast({
    message: payload.value ? "已显示 R18 内容" : "已隐藏 R18 内容",
    level: "info",
    seconds: 2,
  });
  return {};
}

async function onHiddenTagsChanged(
  payload: SettingChangedPayload<string[]> = {
    extern: {},
    key: "content.hiddenTags",
    value: [],
  },
): Promise<Record<string, unknown>> {
  await pluginConfig.save(payload.key, JSON.stringify({ value: payload.value }));
  return {};
}

async function clearPluginCache(): Promise<Record<string, unknown>> {
  try {
    await cache.delete("91tutu:index");
  } catch {
  }
  await flutterTools.showToast({
    message: "91图图缓存已清理",
    level: "success",
    seconds: 2,
  });
  return { ok: true };
}

export default {
  // lifecycle
  init,
  getInfo,

  // core
  searchComic,
  getComicDetail,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,
  getDownloadConcurrency,

  // social
  toggleLike,
  toggleFavorite,
  listFavoriteFolders,
  moveFavoriteToFolder,
  getCommentFeed,
  loadCommentReplies,
  postComment,
  postCommentReply,

  // discovery
  getAdvancedSearchScheme,
  getComicListSceneBundle,
  getRankingData,
  getRankingFilterBundle,

  // settings
  getSettingsBundle,
  getCapabilitiesBundle,
  getUserInfoBundle,

  // fnPath callbacks
  onAuthChanged,
  onRememberChanged,
  onThemeChanged,
  onQualityChanged,
  onAdultChanged,
  onHiddenTagsChanged,
  clearPluginCache,

  // function pages
  getFunctionPage,
};

// 让未使用检查闭嘴：这些常量在 site.ts 中已导出，这里显式引用可提升可读性
void IMAGES_PER_CHAPTER;
void toPostSlug;
void CACHE_TTL_DETAIL_MS;
void detailToItem;
