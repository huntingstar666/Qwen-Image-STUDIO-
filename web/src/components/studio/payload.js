/**
 * 「图片精修 → AI 修改」的请求构造（纯函数，便于单测）。
 *
 * 契约以现有 `web/src/components/edit.js` 提交的 /api/edit payload 为准，
 * 新能力（预处理 / 零偏移 / 色彩保护 / 任务）只做**追加字段**，
 * 后端未实现时会安全忽略，不需要前端降级。
 */

export const SNAP = 32;
export const MAX_SIDE_DEFAULT = 2048;
export const MIN_SIDE_DEFAULT = 768;

/** 向上取整到 multiple 的倍数（像素对齐，不裁内容）。 */
export function snapUp(value, multiple = SNAP) {
  const n = Math.max(1, Math.round(Number(value) || 0));
  return Math.ceil(n / multiple) * multiple;
}

export function snapDims({ width, height }, multiple = SNAP) {
  return { width: snapUp(width, multiple), height: snapUp(height, multiple) };
}

/**
 * 计算真正送进模型的工作画布：长边超限才等比缩小，再向上对齐 32。
 * 返回 scale 便于 UI 说明「原图 → 工作画布 → 还原」。
 */
export function workSize(size, { preprocess = true, maxSide = MAX_SIDE_DEFAULT, multiple = SNAP } = {}) {
  const srcW = Math.max(1, Math.round(Number(size?.width) || 1));
  const srcH = Math.max(1, Math.round(Number(size?.height) || 1));
  let width = srcW;
  let height = srcH;
  let scaled = false;
  const limit = Number(maxSide) || 0;
  if (preprocess && limit > 0 && Math.max(srcW, srcH) > limit) {
    const k = limit / Math.max(srcW, srcH);
    width = Math.max(1, Math.round(srcW * k));
    height = Math.max(1, Math.round(srcH * k));
    scaled = true;
  }
  const snapped = snapDims({ width, height }, multiple);
  return {
    width: snapped.width,
    height: snapped.height,
    scaled,
    scale: snapped.width / srcW,
    source: { width: srcW, height: srcH },
  };
}

const TASK_RULES = [
  { task: 'panorama', re: /全景|panorama|panoramic|宽幅全景/i },
  { task: 'outpaint', re: /扩图|外扩|延展|向外扩展|补边|outpaint|expand\s*(the\s*)?canvas/i },
  { task: 'remove', re: /移除|去除|去掉|删除|抹掉|消除|清理|remove|erase|delete/i },
  { task: 'replace', re: /替换|换成|改为|改成|置换|replace|swap/i },
];

/** 按指令关键词推断任务（用于自动挂任务 LoRA / 决定是否开启遮罩孔洞填充）。 */
export function detectTask(prompt, hasMask = false) {
  const text = String(prompt || '');
  for (const rule of TASK_RULES) {
    if (rule.re.test(text)) return rule.task;
  }
  return hasMask ? 'inpaint' : 'edit';
}

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * 把 UI 里的 `@图二` 转成模型能理解的 `图2`；越界引用原样保留。
 * @param {string} text
 * @param {number} count 总图数（含主图）
 */
export function mapMentions(text, count) {
  return String(text || '').replace(/@图\s*([一二三四五六七八九十]|\d{1,2})/g, (raw, token) => {
    const index = /^\d+$/.test(token) ? Number(token) : CN_DIGITS[token] || 0;
    if (!index || index > count) return raw;
    return `图${index}`;
  });
}

/** 自动挑选任务 LoRA：按关键词匹配后端返回的 LoRA 列表，找不到就不挂。 */
export function pickTaskLora(loras, task) {
  if (!task || task === 'edit' || task === 'inpaint') return null;
  const rules =
    task === 'remove'
      ? [/移除|remove|erase/i]
      : task === 'outpaint'
        ? [/扩图|外扩|outpaint|expand/i]
        : [];
  if (!rules.length) return null;
  const list = Array.isArray(loras) ? loras : [];
  for (const rule of rules) {
    const hit = list.find((item) => rule.test(item.label || item.value || item.name || ''));
    if (hit) return { name: hit.value || hit.name, strength: task === 'remove' ? 1.0 : 0.7 };
  }
  return null;
}

/** 一致性 LoRA：优先用后端默认值，其次按关键词找，最后退回首项。 */
export function pickConsistencyLora(loras, defaultPath = '') {
  const list = (Array.isArray(loras) ? loras : []).filter(Boolean);
  if (!list.length) return '';
  const defaultName = String(defaultPath || '').split(/[\\/]/).pop();
  if (defaultName) {
    const hit = list.find((item) => String(item.value || item.name || '').split(/[\\/]/).pop() === defaultName);
    if (hit) return hit.value || hit.name;
  }
  const named = list.find((item) => /consistency|一致性/i.test(item.label || item.value || item.name || ''));
  if (named) return named.value || named.name;
  return list[0].value || list[0].name || '';
}

function clampStrength(value, fallback = 0.48) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, n));
}

/**
 * 把扁平覆盖项（`local.feather`）展开成请求里的嵌套对象。
 * 未覆盖的键不出现，后端按「显式 > 预设 > 内置默认」补全（§13.5）。
 */
export function nestOverrides(overrides) {
  const out = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    const parts = String(key).split('.');
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return out;
}

/**
 * 构造 /api/edit payload。
 *
 * 两种模式：
 * - 传 `settings.preset`：只发 `preset` + 覆盖项（+ 关闭的保护开关），其余由后端预设补全；
 * - 不传 `settings.preset`：保持旧行为（完整 local/preprocess/zero_shift），第三方与老前端不受影响。
 *
 * @param {{
 *   main: {data:string, name:string, width:number, height:number},
 *   mask: string|null,
 *   prompt: string,
 *   negative?: string,
 *   refs: Array<{name:string, data:string}>,
 *   settings: object,
 *   loras: {task:string, consistency:boolean, consistencyName:string, strength:number, custom:Array<{name:string,strength:number}>},
 *   sampling: {steps:number, cfg:number, sampler:string, scheduler:string, turbo:{enabled:boolean, profile:string}},
 *   task?: string,
 * }} input
 */
export function buildEditPayload({
  main,
  mask = null,
  prompt,
  negative = '',
  refs = [],
  settings = {},
  loras = {},
  sampling = {},
  task = 'edit',
}) {
  const imageCount = 1 + refs.length;
  const text = mapMentions(prompt, imageCount);
  const hasMask = Boolean(mask);
  const sizeMode = settings.sizeMode || 'follow';
  const preprocess = settings.preprocess !== false;
  const maxSide = Number(settings.maxSide) || MAX_SIDE_DEFAULT;
  const work = workSize({ width: main?.width, height: main?.height }, { preprocess, maxSide });
  const scheme = resolveScheme(settings.scheme, settings.hasMask ?? hasMask, settings.coverage || 0);

  const presetId = String(settings.preset || '').trim();
  const overrides = settings.overrides && typeof settings.overrides === 'object' ? settings.overrides : {};

  const loraList = [];
  const taskLora = loras.taskLora || null;
  if (taskLora?.name) loraList.push({ name: taskLora.name, strength: clampStrength(taskLora.strength, 1) });
  for (const item of loras.custom || []) {
    if (item?.name) loraList.push({ name: item.name, strength: clampStrength(item.strength, 1) });
  }

  const payload = {
    prompt: text,
    negative_prompt: String(negative || ''),
    images: [
      { name: main?.name || 'main.png', data: main?.data || '' },
      ...refs.map((ref, index) => ({ name: ref.name || `ref-${index + 2}.png`, data: ref.data })),
    ],
    size_mode: sizeMode,
    width: sizeMode === 'custom' ? snapUp(settings.width) : null,
    height: sizeMode === 'custom' ? snapUp(settings.height) : null,
    ratio: sizeMode === 'ratio' ? settings.ratio || '1:1' : null,
    megapixels: sizeMode === 'ratio' ? Number(settings.megapixels) || null : null,
    fit: 'pad',
    pad_mode: 'edge',
    mask: hasMask ? { data: mask } : null,
    resolution: 0,
    steps: Math.max(1, Math.round(Number(sampling.steps) || 9)),
    cfg: Number(sampling.cfg) || 1,
    seed: null,
    denoise: 1,
    sampler: sampling.sampler || 'euler',
    scheduler: sampling.scheduler || 'simple',
    turbo: sampling.turbo?.enabled
      ? { enabled: true, profile: sampling.turbo.profile || '' }
      : { enabled: false, profile: null },
    loras: loraList,
    consistency_lora:
      loras.consistency && loras.consistencyName
        ? { name: loras.consistencyName, strength: clampStrength(loras.strength, 0.48) }
        : false,
    task: { mode: task },
    meta: {
      source: 'web/studio',
      rawPrompt: String(prompt || ''),
      task,
      targetSize: { width: main?.width || 0, height: main?.height || 0 },
      workSize: { width: work.width, height: work.height },
      maskSize: hasMask ? { width: main?.width || 0, height: main?.height || 0 } : null,
      consistencyStrength: loras.consistency ? clampStrength(loras.strength, 0.48) : null,
      preset: presetId || null,
      client: 'qwen-image2.1-web',
    },
  };

  if (!presetId) {
    // ===== 旧行为：完整参数（兼容第三方与老前端）=====
    payload.local = {
      enabled: hasMask && settings.localEnabled !== false,
      scheme,
      feather: Math.round(Number(settings.feather ?? 32) || 0),
      color_match: settings.colorGuard !== false,
      color_strength: 0.6,
      color_restore: settings.colorGuard !== false,
      color_restore_strength: 1.0,
      mask_expand: Math.round(Number(settings.maskExpand ?? 0) || 0),
      blend_pixels: 24,
      fills: task === 'remove',
      hint: task === 'remove' ? 'green' : 'none',
      consistency: Boolean(loras.consistency),
      expand_top: 1.3,
      expand_bottom: 1.4,
      expand_left: 1.4,
      expand_right: 1.4,
    };
    payload.preprocess = {
      enabled: preprocess,
      max_side: maxSide,
      min_side: MIN_SIDE_DEFAULT,
      multiple: SNAP,
      mode: 'downscale_only',
    };
    payload.zero_shift = { enabled: settings.zeroShift !== false, snap: SNAP, resolution: 0 };
    if (task === 'panorama' || task === 'panorama360') {
      payload.local.scheme = 'a';
      payload.local.fills = false;
      payload.local.hint = 'gray_fill';
    }
    return payload;
  }

  // ===== 预设模式：preset + 覆盖项 =====
  payload.preset = presetId;
  // 任务框停在「自动」（settings.taskExplicit === false）时不发 task，交给预设决定：
  // 显式 task 会被后端判定为「与预设任务不一致」，把预设的提示图/填洞/任务 LoRA 复位。
  if (settings.taskExplicit === false) delete payload.task;
  // denoise 没有 UI 入口，值只会来自预设：不回传，否则固定 1 会把预设里的降噪覆盖掉。
  delete payload.denoise;
  const extra = nestOverrides(overrides);
  const localExtra = { ...(extra.local || {}) };
  // 没有遮罩时显式关闭局部编辑：与图生图页一致，也避免质量报告把整图编辑显示成局部编辑。
  // 有遮罩时交给预设 / 覆盖项决定，页面不代判。
  if (!hasMask) localExtra.enabled = false;
  // 任务训练约定优先于预设文案：移除必须填洞 + 绿提示，扩图必须灰提示。
  if (task === 'remove') {
    localExtra.fills = true;
    localExtra.hint = 'green_overlay';
  } else if (task === 'outpaint') {
    localExtra.fills = false;
    localExtra.hint = 'gray_fill';
  } else if (task === 'panorama' || task === 'panorama360') {
    localExtra.scheme = 'a';
    localExtra.fills = false;
    localExtra.hint = 'gray_fill';
  }
  // 色彩校准 / 零偏移已由 overrides（local.color_match / zero_shift.enabled）下发，
  // 不再单独读 protection，避免与预设两套状态打架。
  // 一致性开关是用户当前选择，开/关都要显式落字段：只在关闭时发 false 的话，
  // 用户重新打开会沿用预设里保存的 false（B1：后端把 null 当"未传"）。
  localExtra.consistency = Boolean(loras.consistency);
  if (Object.keys(localExtra).length) extra.local = localExtra;
  Object.assign(payload, extra);
  return payload;
}

/** auto：遮罩面积小用整画布（a，接缝更稳），面积大用区域裁剪（b，更快）。 */
export function resolveScheme(scheme, hasMask, coverage) {
  if (!hasMask) return 'a';
  if (scheme === 'a' || scheme === 'b') return scheme;
  return coverage > 0.02 && coverage < 0.45 ? 'b' : 'a';
}

/* ============================================================
 * 全景画布预估（与 server/imaging.panorama_plan 同一套算法）
 * ============================================================ */

export const PANORAMA_ASPECTS = ['2:1', '3:1', '4:1', '21:9'];

/** 与后端一致的总像素上限：覆盖 3072×1536，拦住 4096×2048。 */
export const PANORAMA_MAX_PIXELS = 6_000_000;

/**
 * 360° 全景预估：固定 2:1 画布，源图缩到 coverage 后居中，四周留补边区。
 * 与后端 `imaging.panorama360_plan` 同一套规则（只缩不放、32 对齐、6MP 上限）。
 */
export function panorama360Plan(size, {
  coverage = 0.4,
  longSide = 3072,
  multiple = SNAP,
  maxPixels = PANORAMA_MAX_PIXELS,
} = {}) {
  const srcW = Math.max(1, Math.round(Number(size?.width) || 1));
  const srcH = Math.max(1, Math.round(Number(size?.height) || 1));
  const cov = Math.min(0.6, Math.max(0.3, Number(coverage) || 0.4));
  const step = Math.max(2, multiple * 2);
  let width = Math.max(step, Math.floor((Number(longSide) || 3072) / step) * step);
  if (maxPixels > 0) {
    const budget = Math.floor(Math.sqrt(2 * maxPixels) / step) * step;
    width = Math.max(step, Math.min(width, budget));
  }
  const height = Math.max(multiple, Math.floor(width / 2));

  const snapDown = (value) => Math.max(multiple, Math.floor(value / multiple) * multiple);
  let workWidth = snapDown(Math.min(srcW, width * cov));
  let workHeight = snapDown(Math.min(srcH, (workWidth * srcH) / srcW));
  const cap = snapDown(height * 0.85);
  if (workHeight > cap) {
    workHeight = cap;
    workWidth = snapDown(Math.min(srcW, (workHeight * srcW) / srcH));
  }
  const pixels = width * height;
  return {
    width,
    height,
    workWidth,
    workHeight,
    coverage: cov,
    megapixels: Math.round((pixels / 1e6) * 100) / 100,
    overPixels: maxPixels > 0 && pixels > maxPixels,
  };
}
/**
 * 按目标比例算全景画布尺寸（只缩不放），用于面板上的实时预估。
 * 与后端 `imaging.panorama_plan` 保持同一套「最小外扩 → 长边/像素上限」规则。
 *
 * @param {{width:number,height:number}} size 源图尺寸
 * @param {{aspect?:string, longSide?:number, multiple?:number, maxPixels?:number}} [options]
 * @returns {{width:number,height:number,scale:number,megapixels:number,overPixels:boolean}}
 */
export function panoramaPlan(size, { aspect = '2:1', longSide = 3072, multiple = SNAP, maxPixels = PANORAMA_MAX_PIXELS } = {}) {
  const srcW = Math.max(1, Math.round(Number(size?.width) || 1));
  const srcH = Math.max(1, Math.round(Number(size?.height) || 1));
  const [aw, ah] = String(aspect).split(':').map(Number);
  const ratio = aw > 0 && ah > 0 ? aw / ah : 2;
  const current = srcW / srcH;

  let naturalW;
  let naturalH;
  if (current < ratio) {
    naturalW = Math.max(srcW, Math.ceil(srcH * ratio));
    naturalH = srcH;
  } else if (current > ratio) {
    naturalW = srcW;
    naturalH = Math.max(srcH, Math.ceil(srcW / ratio));
  } else {
    naturalW = srcW;
    naturalH = srcH;
  }

  let width = snapUp(naturalW, multiple);
  let height = snapUp(naturalH, multiple);
  const limit = Number(longSide) || 0;
  let scale = 1;
  if (limit > 0 && Math.max(width, height) > limit) scale = limit / Math.max(width, height);
  if (maxPixels > 0 && width * height * scale * scale > maxPixels) {
    scale = Math.min(scale, Math.sqrt(maxPixels / (width * height)));
  }
  if (scale < 1) {
    // 向下取整到 32 的倍数，确保缩小后不越过长边 / 像素上限。
    width = Math.max(multiple, Math.floor(Math.round(width * scale) / multiple) * multiple);
    height = Math.max(multiple, Math.floor(Math.round(height * scale) / multiple) * multiple);
  }
  const pixels = width * height;
  return {
    width,
    height,
    scale: Math.round(scale * 1000) / 1000,
    megapixels: Math.round((pixels / 1e6) * 100) / 100,
    overPixels: maxPixels > 0 && pixels > maxPixels,
  };
}
