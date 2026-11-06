/**
 * 全景 / 扩图 / 视角草稿的参数构造（移植自 `imageAngleDraft.ts`）。
 * 只生成节点字段补丁，不依赖画布；新建与连线由宿主完成。
 */

export const panoramaPrompt =
  '基于参考图片重建同一场景，生成覆盖水平360度、垂直180度的完整球面全景等距柱状投影贴图。以原图主要内容为前方视线中心，向两侧和背后合理补全空间。整张画面承载完整经纬度范围，优先2:1展开；不要只生成宽幅风景、鱼眼图或多图拼版。左右边缘无缝连续，顶部天顶与底部地面自然闭合，避免接缝、断层、重复主体及局部拉伸。保持原图光照、材质、人物身份与画面风格，封闭空间保留合理出入口。不添加文字、水印、边框或界面。';

export const panoramaAspectRatio = '2:1';

const directions = ['正面', '左前', '左侧', '左后', '背面', '右后', '右侧', '右前'];

export function angleLabel(angle) {
  if (!angle) return '默认';
  const azimuth = Number(angle.azimuth) || 0;
  const elevation = Number(angle.elevation) || 0;
  return `${directions[Math.round(((azimuth % 360) + 360) % 360 / 45) % 8]} · ${
    elevation > 10 ? '俯视' : elevation < -10 ? '仰视' : '平视'
  }`;
}

/** 全景草稿：固定 2:1，带全景提示词，不带视角参数。 */
export function buildPanoramaDraft(source, options = {}) {
  if (!source?.resultUrl && !source?.url) throw new Error('原图尚未准备好，请稍后重试。');
  return {
    title: options.title || '全景图',
    prompt: options.prompt || panoramaPrompt,
    aspectRatio: panoramaAspectRatio,
    resolution: options.resolution || '1K',
    generateCount: 1,
    imageMode: 'image-to-image',
    imageAngle: null,
  };
}

/** 扩图 / 新视角草稿：提示词留空，靠 imageAngle 与参考图控制。 */
export function buildOutpaintDraft(source, options = {}) {
  if (!source?.resultUrl && !source?.url) throw new Error('原图尚未准备好，请稍后重试。');
  const angle = options.angle || null;
  const allowed = Array.isArray(options.aspectRatios) ? options.aspectRatios.map(String) : null;
  const sourceRatio = String(source.aspectRatio || '');
  const aspectRatio = angle
    ? (allowed && allowed.includes(sourceRatio) ? sourceRatio : '16:9')
    : options.aspectRatio || panoramaAspectRatio;
  return {
    title: angle ? `角度 · ${angleLabel(angle)}` : options.title || '扩图',
    prompt: options.prompt || '',
    aspectRatio,
    resolution: options.resolution || '1K',
    generateCount: 1,
    imageMode: 'image-to-image',
    imageAngle: angle,
  };
}

/** 扩图方向 → 视角参数（用于“向左/右/上/下扩图”按钮）。 */
export const outpaintDirections = {
  left: { azimuth: 270, elevation: 0, zoom: 5 },
  right: { azimuth: 90, elevation: 0, zoom: 5 },
  up: { azimuth: 0, elevation: 35, zoom: 5 },
  down: { azimuth: 0, elevation: -25, zoom: 5 },
};
