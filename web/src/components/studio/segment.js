/**
 * AI 主体选择（D13.1）的前端纯函数。
 *
 * 与后端 `POST /api/image/segment` 的契约保持一致：
 * - 输入坐标是「发送图」的像素坐标（未裁剪 + 可能等比缩小）；
 * - 输出蒙版是灰度 PNG（白 = 选中），尺寸与发送图一致。
 */

export const SEGMENT_MAX_SIDE = 2048;

export const SEGMENT_MODES = [
  { id: 'subject', label: '主体', hint: '点一下要选的主体：落点作为提示交给 SAM 3.1（自动模式下不可用时回退 BiRefNet）' },
  { id: 'box', label: '框选', hint: '拖框选范围；Shift 点击加点、Alt 点击排除，框和点会一起送给 SAM 3.1' },
  { id: 'points', label: '点选', hint: '点主体上的点累积提示；Alt 点击标记排除（负点）' },
  { id: 'text', label: '文字', hint: '写描述后点「选取」；可先在画面上拖框限制搜索范围' },
];

/**
 * 推理发送尺寸：长边超过上限时等比缩小（只缩不放）。
 * @returns {{width:number,height:number,scale:number}}
 */
export function segmentSendSize(width, height, maxSide = SEGMENT_MAX_SIDE) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const limit = Number(maxSide) || 0;
  const scale = limit > 0 && Math.max(w, h) > limit ? limit / Math.max(w, h) : 1;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/**
 * 平移到未裁剪图像坐标（界面上看到的是裁剪后的坐标）。
 * @param {{x:number,y:number}} point
 * @param {{x:number,y:number}|null} crop
 */
export function toImagePoint(point, crop = null) {
  return {
    x: Number(point?.x || 0) + (crop?.x || 0),
    y: Number(point?.y || 0) + (crop?.y || 0),
  };
}

/** 点提示：图像坐标 × 发送缩放；label 1 = 前景，0 = 排除。 */
export function toSendPoints(points, scale = 1, crop = null) {
  return (Array.isArray(points) ? points : []).slice(0, 64).map((point) => {
    const image = toImagePoint(point, crop);
    return {
      x: Math.round(image.x * scale * 10) / 10,
      y: Math.round(image.y * scale * 10) / 10,
      label: point?.label === 0 ? 0 : 1,
    };
  });
}

/** 框提示：图像坐标 × 发送缩放，返回 `{x,y,width,height}`（后端要求）。 */
export function toSendBox(rect, scale = 1, crop = null) {
  const x = (Number(rect?.x || 0) + (crop?.x || 0)) * scale;
  const y = (Number(rect?.y || 0) + (crop?.y || 0)) * scale;
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    width: Math.round(Number(rect?.width || 0) * scale * 10) / 10,
    height: Math.round(Number(rect?.height || 0) * scale * 10) / 10,
  };
}

/**
 * 灰度蒙版 → 选区 alpha。
 * 后端输出灰度 PNG（白 = 选中，R=G=B），这里取 R 通道；
 * 若图像带透明（未来变体），用 alpha 兜底。
 */
export function maskGrayToAlpha(data, width, height) {
  const length = Math.max(0, Math.round(Number(width) * Number(height)));
  const alpha = new Uint8Array(length);
  if (!data || !length) return alpha;
  for (let i = 0; i < length; i += 1) {
    const at = i * 4;
    const a = data[at + 3];
    alpha[i] = a && a < 250 ? a : data[at];
  }
  return alpha;
}

/** 按 score 降序 + 面积兜底，返回可用的候选蒙版列表。 */
export function sortSegmentMasks(masks) {
  const list = (Array.isArray(masks) ? masks : []).filter((item) => item && item.url);
  return list.slice().sort((a, b) => {
    const scoreDiff = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
    return (Number(b.area) || 0) - (Number(a.area) || 0);
  });
}
