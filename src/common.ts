export const PLUGIN_ID = "99fe583b-0cbd-4307-b595-577bb35bdd12";

/** 站点根地址 */
export const SITE_ORIGIN = "https://91tutu.cc";

/** 图片主机根地址 */
export const IMAGE_ORIGIN = "https://image.91tutu.cc";

// 占位图片 URL：必须是有效格式的非空字符串，不能为 404 地址。
// 宿主不会用它下载图片，但会校验格式。
export const NOT_FOUND_IMAGE_URL = "https://httpstat.us/200?identifier=placeholder";

export const PLACEHOLDER_IMAGE_PATH = "placeholder/image-404.png";

import type {
  ActionItem,
  ComicInfoPageAction,
  ComicListItem,
  ImageItem,
  MetadataListItem,
  PagingInfo,
  StringMap,
} from "breeze-plugin-kit";

const EMPTY_ACTION = {} as ComicInfoPageAction;

export function toStringMap(value: unknown): StringMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function createActionItem(
  name: unknown,
  onTap: ComicInfoPageAction = EMPTY_ACTION,
  extern: StringMap = {},
): ActionItem {
  // Keep all action payloads normalized so downstream schema consumers do not
  // have to special-case missing fields.
  return {
    name: String(name ?? ""),
    onTap,
    extern,
  };
}

export function createImage(
  input: {
    id?: string;
    url?: string;
    name?: string;
    path?: string;
    extern?: StringMap;
  } = {},
): ImageItem {
  return {
    id: String(input.id ?? ""),
    url: String(input.url ?? "").trim() || NOT_FOUND_IMAGE_URL,
    name: String(input.name ?? ""),
    path: String(input.path ?? "").trim() || PLACEHOLDER_IMAGE_PATH,
    extern: input.extern ?? {},
  };
}

export function createMetadataActionList(
  type: string,
  name: string,
  values: unknown,
  mapItem?: (value: string) => ActionItem,
): MetadataListItem {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const normalized = list
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0)
    .map((item) => (mapItem ? mapItem(item) : createActionItem(item)));

  return {
    type,
    name,
    value: normalized,
  };
}

export function createBasicMetadata(type: string, name: string, values: unknown): MetadataListItem {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return {
    type,
    name,
    value: list
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .map((item) => createActionItem(item)),
  };
}

/** 列表项构造入参 */
export type ComicItemInput = {
  id: string;
  title: string;
  subtitle?: string;
  coverUrl?: string;
  coverPath?: string;
  tags?: string[];
  categories?: string[];
  authors?: string[];
  updatedAt?: string;
  views?: number;
  likes?: number;
  extern?: StringMap;
};

/**
 * 把任意字符串洗成安全的路径片段。
 * 宿主的 `path` 字段会被拼进本地文件系统路径，因此必须去掉 `/` 等分隔符。
 */
export function sanitizePathSegment(raw: unknown): string {
  return (
    String(raw ?? "")
      .replace(/[/\\:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "unknown"
  );
}

/**
 * 构造 ComicListItem。
 *
 * `id` 必须是站点真实路径（`/posts/<slug>/`），详情页与章节都靠它定位，
 * 不可自行拼接，因为站点 slug 的生成规则（去点号、中文转拼音）不可逆。
 */
export function createComicItem(input: ComicItemInput): ComicListItem;
/** 兼容旧签名，仅用于占位 */
export function createComicItem(id: string, title: string): ComicListItem;
export function createComicItem(
  inputOrId: ComicItemInput | string,
  legacyTitle = "",
): ComicListItem {
  const data: ComicItemInput =
    typeof inputOrId === "string" ? { id: inputOrId, title: legacyTitle } : inputOrId;

  const id = String(data.id ?? "");
  const title = String(data.title ?? "");
  const tags = (data.tags ?? []).filter(Boolean);
  const categories = (data.categories ?? []).filter(Boolean);
  const authors = (data.authors ?? []).filter(Boolean);

  const coverUrl = String(data.coverUrl ?? "").trim();
  const coverPath =
    String(data.coverPath ?? "").trim() || `91tutu/${sanitizePathSegment(id)}.webp`;

  return {
    source: PLUGIN_ID,
    id,
    title,
    subtitle: String(data.subtitle ?? ""),
    finished: false,
    likesCount: Number(data.likes ?? 0) || 0,
    viewsCount: Number(data.views ?? 0) || 0,
    updatedAt: String(data.updatedAt ?? ""),
    cover: {
      id,
      url: coverUrl || NOT_FOUND_IMAGE_URL,
      path: coverPath,
      name: "",
      extern: { path: coverPath },
    },
    metadata: [
      createBasicMetadata("author", "作者", authors),
      createBasicMetadata("categories", "分类", categories),
      createBasicMetadata("tags", "标签", tags),
      createBasicMetadata("works", "作品", []),
      createBasicMetadata("actors", "角色", []),
    ],
    raw: {
      id,
      name: title,
      author: authors.join(", "),
      description: String(data.subtitle ?? ""),
      image: coverUrl,
      category: { id: categories[0] ?? "", title: categories[0] ?? "" },
      category_sub: { id: null, title: null },
      liked: false,
      is_favorite: false,
      update_at: 0,
      likes: Number(data.likes ?? 0) || 0,
      totalViews: Number(data.views ?? 0) || 0,
      tags,
      works: [],
      actors: [],
      related_list: [],
    },
    extern: { ...(data.extern ?? {}), path: id },
  } satisfies ComicListItem;
}

export function createPaging(page = 1, total = 1): PagingInfo {
  return {
    page,
    pages: Math.max(1, total),
    total,
    hasReachedMax: true,
  };
}
