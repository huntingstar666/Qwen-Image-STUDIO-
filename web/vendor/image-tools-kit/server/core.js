/**
 * 后端裁切 / 宫格（sharp 实现，框架无关）。
 * 原项目 `server/media/mediaEditingRouter.js` 的裁剪与宫格部分，去掉了项目目录约定。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { cropSegments, equalCuts } from '../src/cropGeometry.js';

export class ImageEditingError extends Error {
  constructor(message, status = 400, code = 'IMAGE_EDIT_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const integer = (value, label, minimum = 0) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ImageEditingError(`${label}必须是数字`);
  const rounded = Math.round(number);
  if (rounded < minimum) throw new ImageEditingError(`${label}不能小于 ${minimum}`);
  return rounded;
};

const outputName = (operation, extension) =>
  `${operation}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${extension}`;

/**
 * @param {object} options
 * @param {any} options.sharp            sharp 实例（由调用方注入，避免本包强依赖）
 * @param {string} options.outputDirectory 产物目录（会被静态服务暴露）
 * @param {string} [options.outputUrl]   产物对外 URL 前缀，默认 /generated
 */
export function createImageEditingService({ sharp, outputDirectory, outputUrl = '/generated', logger = console }) {
  if (typeof sharp !== 'function') throw new Error('createImageEditingService 需要传入 sharp');
  if (!outputDirectory) throw new Error('outputDirectory is required');

  async function save(buffer, operation, extension = 'png', extra = {}) {
    await mkdir(outputDirectory, { recursive: true });
    const name = outputName(operation, extension);
    const target = path.join(outputDirectory, name);
    await writeFile(target, buffer);
    const metadata = await sharp(buffer).metadata();
    return {
      url: `${outputUrl.replace(/\/$/, '')}/${name}`,
      path: target,
      width: metadata.width || null,
      height: metadata.height || null,
      ...extra,
    };
  }

  async function crop({ source, rect, format = 'png', quality = 92 }) {
    const metadata = await sharp(source).metadata();
    const left = integer(rect?.x, '裁切横坐标');
    const top = integer(rect?.y, '裁切纵坐标');
    const width = integer(rect?.width, '裁切宽度', 1);
    const height = integer(rect?.height, '裁切高度', 1);
    if (left + width > metadata.width || top + height > metadata.height) {
      throw new ImageEditingError('裁切区域超出图片范围');
    }
    const buffer = await sharp(source)
      .extract({ left, top, width, height })
      .toFormat(format, { quality })
      .toBuffer();
    return save(buffer, 'crop', format, { cropRect: { x: left, y: top, width, height } });
  }

  async function grid({ source, rect, rows, columns, horizontalGap = 0, verticalGap = 0, columnGuides, rowGuides, format = 'png', quality = 92 }) {
    const metadata = await sharp(source).metadata();
    const rowCount = integer(rows, '宫格行数', 1);
    const columnCount = integer(columns, '宫格列数', 1);
    if (rowCount > 10 || columnCount > 10 || rowCount * columnCount > 64) {
      throw new ImageEditingError('宫格数量超过限制（最多 10×10 且不超过 64 块）');
    }
    const area = rect
      ? {
          x: integer(rect.x, '裁切横坐标'),
          y: integer(rect.y, '裁切纵坐标'),
          width: integer(rect.width, '裁切宽度', 1),
          height: integer(rect.height, '裁切高度', 1),
        }
      : { x: 0, y: 0, width: metadata.width, height: metadata.height };
    if (area.x + area.width > metadata.width || area.y + area.height > metadata.height) {
      throw new ImageEditingError('裁切区域超出图片范围');
    }
    const guides = (value, count, label) => {
      if (!Array.isArray(value) || !value.length) return equalCuts(count);
      if (value.length !== count - 1) throw new ImageEditingError(`${label}数量应为 ${Math.max(0, count - 1)}`);
      const cuts = value.map((item) => Number(item));
      if (cuts.some((item) => !Number.isFinite(item) || item <= 0 || item >= 1)) {
        throw new ImageEditingError(`${label}必须位于 0 到 1 之间`);
      }
      return [...cuts].sort((a, b) => a - b);
    };
    const columnCuts = guides(columnGuides, columnCount, '列分割线');
    const rowCuts = guides(rowGuides, rowCount, '行分割线');
    const columnRanges = cropSegments(area.x, area.width, columnCuts, integer(horizontalGap, '横向间距'));
    const rowRanges = cropSegments(area.y, area.height, rowCuts, integer(verticalGap, '纵向间距'));
    const assets = [];
    for (let row = 0; row < rowRanges.length; row += 1) {
      for (let column = 0; column < columnRanges.length; column += 1) {
        const x = columnRanges[column];
        const y = rowRanges[row];
        const width = Math.round(x.size);
        const height = Math.round(y.size);
        if (width < 1 || height < 1) continue;
        const buffer = await sharp(source)
          .extract({ left: Math.round(x.start), top: Math.round(y.start), width, height })
          .toFormat(format, { quality })
          .toBuffer();
        assets.push(await save(buffer, 'grid', format, {
          gridRow: row,
          gridColumn: column,
          gridRows: rowCount,
          gridColumns: columnCount,
          index: row * columnRanges.length + column,
        }));
      }
    }
    if (!assets.length) throw new ImageEditingError('没有可输出的宫格');
    return assets;
  }

  return { crop, grid, save, logger };
}

export default createImageEditingService;
