/**
 * 纯前端裁切：用 canvas 直接切图，不依赖后端。
 * 坐标为原图像素；`gridRects` 的输出可直接传入。
 */

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败，可能是跨域限制。'));
    image.src = src;
  });
}

function draw(image, rect) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境不支持 canvas 裁切。');
  context.drawImage(
    image,
    Math.round(rect.x),
    Math.round(rect.y),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

export function cropToDataUrl(image, rect, { format = 'image/png', quality = 0.92 } = {}) {
  return draw(image, rect).toDataURL(format, quality);
}

export function gridToDataUrls(image, rects, options) {
  return rects.map((rect) => ({
    dataUrl: cropToDataUrl(image, rect, options),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    row: rect.row,
    column: rect.column,
  }));
}

export function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
}
