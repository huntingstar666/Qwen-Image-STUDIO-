/**
 * 叠加层：主图之上可拖动 / 缩放 / 调透明度的图片（例如一张扣好的素材）。
 *
 * 约束：
 * 1. 底图永远锁定，不可移动；只有叠加层是可编辑对象；
 * 2. 坐标使用「主图图像坐标」，与 doc.renderBase() 同尺寸，导出时一起烘焙；
 * 3. 叠加层不参与蒙版，蒙版始终只作用于底图坐标系。
 */

let seq = 0;

export class OverlayLayer {
  constructor(image, { name = '叠加图', x = 0, y = 0, scale = 1, opacity = 1, rotation = 0, id = '' } = {}) {
    this.id = id || `ov-${(seq += 1)}`;
    this.image = image;
    this.name = name;
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.scale = Number(scale) || 1;
    this.opacity = opacity === undefined ? 1 : Number(opacity);
    this.rotation = Number(rotation) || 0;
  }

  get width() {
    return (this.image?.naturalWidth || this.image?.width || 0) * this.scale;
  }

  get height() {
    return (this.image?.naturalHeight || this.image?.height || 0) * this.scale;
  }

  bounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  hitTest(px, py) {
    const box = this.bounds();
    return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
  }

  draw(ctx) {
    if (!this.image || this.opacity <= 0 || this.width < 1 || this.height < 1) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));
    if (this.rotation) {
      ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
      ctx.rotate((this.rotation * Math.PI) / 180);
      ctx.drawImage(this.image, -this.width / 2, -this.height / 2, this.width, this.height);
    } else {
      ctx.drawImage(this.image, this.x, this.y, this.width, this.height);
    }
    ctx.restore();
  }

  clone() {
    return new OverlayLayer(this.image, {
      id: this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      scale: this.scale,
      opacity: this.opacity,
      rotation: this.rotation,
    });
  }
}
