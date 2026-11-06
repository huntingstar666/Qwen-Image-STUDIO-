/**
 * 裁切 / 宫格几何（原项目 `imageCropGeometry.ts` 的无类型版本，零依赖）。
 * 坐标为“显示尺寸”坐标；`cropOutputRects` 负责换算到原图像素。
 */

export const cropMargin = 24;

export const cropRatios = [
  '1:1', '2:3', '3:2', '9:16', '16:9', '3:4', '4:3',
  '5:4', '4:5', '21:9', '1:4', '1:8', '4:1', '8:1', '2:1',
];

export const equalCuts = (count) =>
  Array.from({ length: Math.max(0, count - 1) }, (_, index) => (index + 1) / count);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function cropRatio(label, source) {
  if (label === 'Free') return null;
  if (label === 'Original') return source.width / source.height;
  const [width, height] = label.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

export function centeredCrop(size, ratio, fill = 0.8) {
  const aspect = ratio || size.width / size.height;
  const width = Math.min(size.width * fill, size.height * fill * aspect);
  const height = width / aspect;
  return { x: (size.width - width) / 2, y: (size.height - height) / 2, width, height };
}

export function cropHandles(rect) {
  const { x, y, width: w, height: h } = rect;
  return [
    { id: 'tl', x, y },
    { id: 'tr', x: x + w, y },
    { id: 'bl', x, y: y + h },
    { id: 'br', x: x + w, y: y + h },
    { id: 'tc', x: x + w / 2, y },
    { id: 'bc', x: x + w / 2, y: y + h },
    { id: 'ml', x, y: y + h / 2 },
    { id: 'mr', x: x + w, y: y + h / 2 },
  ];
}

export function hitCrop(rect, point) {
  const handle = cropHandles(rect).find(
    (item) => Math.abs(item.x - point.x) < 20 && Math.abs(item.y - point.y) < 20,
  );
  if (handle) return handle.id;
  return point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height
    ? 'move'
    : null;
}

export function createCrop(start, end, size, ratio) {
  const dx = end.x >= start.x ? 1 : -1;
  const dy = end.y >= start.y ? 1 : -1;
  let width = Math.abs(end.x - start.x);
  let height = Math.abs(end.y - start.y);
  if (ratio) {
    width = Math.min(
      width,
      dx > 0 ? size.width - start.x : start.x,
      (dy > 0 ? size.height - start.y : start.y) * ratio,
    );
    height = width / ratio;
  }
  return {
    x: dx > 0 ? start.x : start.x - width,
    y: dy > 0 ? start.y : start.y - height,
    width,
    height,
  };
}

export function resizeCrop(rect, handle, point, size, ratio) {
  const left = handle.includes('l');
  const right = handle.includes('r');
  const top = handle.includes('t');
  const bottom = handle.includes('b');
  let x = rect.x;
  let y = rect.y;
  let width = rect.width;
  let height = rect.height;
  if (left) {
    x = clamp(point.x, 0, rect.x + rect.width - 1);
    width = rect.x + rect.width - x;
  }
  if (right) width = clamp(point.x - rect.x, 1, size.width - rect.x);
  if (top) {
    y = clamp(point.y, 0, rect.y + rect.height - 1);
    height = rect.y + rect.height - y;
  }
  if (bottom) height = clamp(point.y - rect.y, 1, size.height - rect.y);
  if (ratio) {
    if (left || right) height = width / ratio;
    else width = height * ratio;
    const maxWidth = left ? rect.x + rect.width : right ? size.width - rect.x : size.width;
    const maxHeight = top ? rect.y + rect.height : bottom ? size.height - rect.y : size.height;
    const factor = Math.min(1, maxWidth / width, maxHeight / height);
    width *= factor;
    height *= factor;
    x = left ? rect.x + rect.width - width : right ? rect.x : rect.x + (rect.width - width) / 2;
    y = top ? rect.y + rect.height - height : bottom ? rect.y : rect.y + (rect.height - height) / 2;
  }
  return { x: clamp(x, 0, size.width - width), y: clamp(y, 0, size.height - height), width, height };
}

export function moveCrop(rect, delta, size) {
  return {
    ...rect,
    x: clamp(rect.x + delta.x, 0, size.width - rect.width),
    y: clamp(rect.y + delta.y, 0, size.height - rect.height),
  };
}

export function moveCropCut(cuts, index, position, length) {
  const before = cuts[index - 1] ?? 0;
  const after = cuts[index + 1] ?? 1;
  const gap = Math.min(24 / Math.max(1, length), (after - before) / 3);
  return cuts.map((value, i) => (i === index ? clamp(position, before + gap, after - gap) : value));
}

export function cropSegments(start, length, cuts, gap) {
  const boundaries = [start, ...cuts.map((cut) => start + cut * length), start + length];
  const maximumGap = Math.min(
    ...boundaries.slice(1).map((value, index) => {
      const deduction = (index > 0 ? 0.5 : 0) + (index < boundaries.length - 2 ? 0.5 : 0);
      return deduction ? (value - boundaries[index] - 1) / deduction : Infinity;
    }),
  );
  const safeGap = Math.max(0, Math.min(gap, maximumGap));
  return boundaries.slice(0, -1).map((value, index) => {
    const first = value + (index > 0 ? safeGap / 2 : 0);
    const last = boundaries[index + 1] - (index < boundaries.length - 2 ? safeGap / 2 : 0);
    return { start: first, size: Math.max(0, last - first) };
  });
}

export function cropOutputRects(rect, display, source, rowCuts, columnCuts, rowGap, columnGap) {
  const xScale = source.width / display.width;
  const yScale = source.height / display.height;
  const columns = cropSegments(rect.x * xScale, rect.width * xScale, columnCuts, columnGap);
  const rows = cropSegments(rect.y * yScale, rect.height * yScale, rowCuts, rowGap);
  const pixels = (segment, limit) => {
    const start = clamp(Math.round(segment.start), 0, limit);
    const end = clamp(Math.round(segment.start + segment.size), 0, limit);
    if (end <= start) throw new Error('裁切范围太小，无法为每个分块保留至少一个像素。');
    return { start, size: end - start };
  };
  return {
    columns: columns.map((part) => pixels(part, source.width)),
    rows: rows.map((part) => pixels(part, source.height)),
  };
}

/** 按行优先顺序生成宫格输出矩形，便于直接逐个裁切。 */
export function gridRects(rect, display, source, rows, columns, rowGaps = 0, columnGaps = 0) {
  const rowCuts = equalCuts(rows);
  const columnCuts = equalCuts(columns);
  const computed = cropOutputRects(rect, display, source, rowCuts, columnCuts, rowGaps, columnGaps);
  const output = [];
  computed.rows.forEach((row, rowIndex) => {
    computed.columns.forEach((column, columnIndex) => {
      output.push({
        x: column.start,
        y: row.start,
        width: column.size,
        height: row.size,
        row: rowIndex,
        column: columnIndex,
      });
    });
  });
  return output;
}
