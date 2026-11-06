# Breeze Plugin Example

Breeze 插件示例工程，包含所有 API 类型的占位实现。新插件推荐直接 clone 本仓库进行改造。

本示例依赖 [`breeze-plugin-kit`](https://www.npmjs.com/package/breeze-plugin-kit) 提供类型声明和常用工具函数。

## 文档

插件开发文档：[https://deretame.github.io/plugin-dev-docs/](https://deretame.github.io/plugin-dev-docs/)

## 已导出的 fnPath

### 核心

- `getInfo` — 插件信息
- `searchComic` — 搜索漫画
- `getComicDetail` — 漫画详情
- `getReadSnapshot` — 阅读快照
- `getChapter` — 章节内容
- `fetchImageBytes` — 下载图片

### 社交

- `toggleLike` — 点赞
- `toggleFavorite` — 收藏
- `listFavoriteFolders` — 收藏夹列表
- `moveFavoriteToFolder` — 移动到收藏夹
- `getCommentFeed` — 评论列表
- `loadCommentReplies` — 加载回复
- `postComment` — 发评论
- `postCommentReply` — 回复评论

### 发现

- `getAdvancedSearchScheme` — 高级搜索方案
- `getComicListSceneBundle` — 列表场景
- `getRankingData` — 榜单数据
- `getRankingFilterBundle` — 榜单筛选

### 设置

- `getSettingsBundle` — 设置方案
- `getCapabilitiesBundle` — 能力操作
- `getUserInfoBundle` — 用户信息

### 回调

- `onAuthChanged` / `onRememberChanged` / `onThemeChanged` / `onQualityChanged` / `onAdultChanged` / `onHiddenTagsChanged` — 设置字段变更
- `clearPluginCache` — 清理缓存

## 快速开始

```bash
git clone https://github.com/deretame/Breeze-plugin-example.git your-plugin-name
cd your-plugin-name
pnpm install
```

克隆后删除 `.git` 重新初始化：

```bash
# Windows
Remove-Item -Recurse -Force .git

# macOS / Linux
rm -rf .git

git init
```

然后修改 `src/common.ts` 的 `PLUGIN_ID` 和 `src/get-info.ts` 的插件信息。

如需了解 `breeze-plugin-kit` 的 API 用法，参考插件开发文档的 [工具包章节](https://deretame.github.io/plugin-dev-docs/guide/plugin-kit)。

## 图片裁剪工具

`breeze-plugin-kit` 0.8.0 提供了图片裁剪类型和 `pictureTools.cropImageByRegions`：

```ts
import { pictureTools } from "breeze-plugin-kit";
import type { ImageCropRegion } from "breeze-plugin-kit";

async function cropPreviewSheet(imageData: Uint8Array) {
  const regions: ImageCropRegion[] = [
    { number: 1, x: 0, y: 0, width: 200, height: 300 },
    { number: 2, x: 200, y: 0, width: 200, height: 300 },
  ];

  const images = await pictureTools.cropImageByRegions(imageData, regions);
  return images.map(({ number, imgData }) => ({
    number,
    webpBytes: imgData,
  }));
}
```

`imageData` 支持 `Uint8Array`、`ArrayBuffer`、`ArrayBufferView` 和 `number[]`；每个裁剪区域使用左上角为原点的 `x`、`y`、`width`、`height`，返回的 `imgData` 是 WebP 格式的 `Uint8Array`。

## 开发

```bash
pnpm run dev
```

dev server 启动后输出 bundle 地址，在 Breeze 中通过"网络安装"加载即可调试。支持热更新。

## 构建

```bash
pnpm run build
```

构建流程：typecheck → 同步版本号 → 生成 `manifest.json` → rspack 打包 → Brotli 压缩。

**构建前请先更新 `src/get-info.ts` 中的 `version` 字段。**
