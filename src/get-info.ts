import type { InfoContract, OpenComicListAction } from "breeze-plugin-kit";
import { PLUGIN_ID, SITE_ORIGIN } from "./common";

/** 构造一个"打开插件分页列表"入口 */
function buildEntry(
  id: string,
  title: string,
  sceneTitle: string,
  extern: Record<string, string>,
): { id: string; title: string; action: OpenComicListAction } {
  return {
    id,
    title,
    action: {
      type: "openComicList",
      payload: {
        scene: {
          title: sceneTitle,
          source: PLUGIN_ID,
          body: {
            type: "pluginPagedComicList",
            request: {
              fnPath: "getRankingData",
              core: {},
              extern,
            },
          },
          filter: {
            fnPath: "getRankingFilterBundle",
            extern,
          },
        },
      },
    },
  };
}

export function buildPluginInfo(): InfoContract {
  return {
    name: "91图图",
    uuid: PLUGIN_ID,
    iconUrl: `${SITE_ORIGIN}/favicon.svg`,
    describe: "91tutu.cc 图源：最新套图、R18/R17/R16 分级、尺度分类、标签与作者浏览，支持原图打包阅读。",
    version: "1.0.0",
    home: "https://github.com/operit-ai/Breeze-plugin-91tutu",
    updateUrl: "https://github.com/operit-ai/Breeze-plugin-91tutu/releases/latest/download/manifest.json",
    npmName: "breeze-plugin-91tutu",
    function: [
      buildEntry("latest", "最新更新", "91图图 · 最新更新", { kind: "latest" }),
      buildEntry("r18", "R18 分区", "91图图 · R18", { kind: "category", key: "R18" }),
      buildEntry("r17", "R17 分区", "91图图 · R17", { kind: "category", key: "R17" }),
      buildEntry("r16", "R16 分区", "91图图 · R16", { kind: "category", key: "R16" }),
      buildEntry("explicit", "显式尺度", "91图图 · 尺度", { kind: "scale", key: "explicit" }),
      buildEntry("healthy", "健康尺度", "91图图 · 尺度", { kind: "scale", key: "healthy" }),
    ],
  };
}

export function buildManifestInfo(): InfoContract {
  return buildPluginInfo();
}
