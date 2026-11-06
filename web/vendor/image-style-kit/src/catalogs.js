/**
 * 预设目录。
 *
 * 默认直接静态导入随模块打包的两份目录：
 * - creativeCatalog.json：风格 / 运镜 / 滤镜
 * - mjStyleCatalog.json：MJ 码图
 *
 * 预览图不随模块复制（原项目 public 下约 112MB）。默认沿用原路径
 * `/creative-presets`、`/mj-styles`；迁移到新项目时可传 assetBaseUrl，
 * 或运行 `scripts/sync-assets.ps1` 把图片同步过来。
 */
import creativeCatalogData from '../data/creativeCatalog.json' with { type: 'json' };
import mjStyleCatalogData from '../data/mjStyleCatalog.json' with { type: 'json' };
import { validCreativePreset } from './creative.js';

export const creativeCatalog = creativeCatalogData.filter(validCreativePreset);
export const mjStyleCatalog = mjStyleCatalogData;

const DEFAULT_ASSET_BASES = {
  creative: '/creative-presets',
  mj: '/mj-styles',
};

/**
 * 创建资源地址解析器。
 * @param {{creative?:string,mj?:string}} [bases]
 */
export function createAssetResolver(bases = {}) {
  const merged = { ...DEFAULT_ASSET_BASES, ...bases };
  return function resolveAssetUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (/^(https?:|data:|blob:)/.test(url)) return url;
    if (url.startsWith('/creative-presets/')) return `${merged.creative.replace(/\/+$/, '')}${url.slice('/creative-presets'.length)}`;
    if (url.startsWith('/mj-styles/')) return `${merged.mj.replace(/\/+$/, '')}${url.slice('/mj-styles'.length)}`;
    return url;
  };
}

/**
 * 需要动态加载（而不是随包静态导入）时使用。
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 */
export async function loadCatalog(url, fetchImpl = (...args) => globalThis.fetch(...args)) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`目录加载失败：HTTP ${response.status}`);
  return response.json();
}

