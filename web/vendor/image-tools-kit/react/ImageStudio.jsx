/**
 * 图片工作室入口：把裁切、宫格、标注、全景、扩图收在同一个菜单里。
 * 宿主只需提供 `onSave`（裁切/标注产物）与 `onGenerate`（全景/扩图草稿）。
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AnnotateDialog } from './AnnotateDialog.jsx';
import { CropDialog } from './CropDialog.jsx';
import { OutpaintDialog, PanoramaDialog } from './GenerateDialog.jsx';
import { Icon } from './Icon.jsx';

const tools = [
  { id: 'crop', icon: 'crop', name: '裁切', desc: '自由比例裁出局部' },
  { id: 'grid', icon: 'grid', name: '宫格裁切', desc: '按行列切成多张，可设间距' },
  { id: 'annotate', icon: 'brush', name: '画笔标注', desc: '输出叠加图与重绘蒙版' },
  { id: 'panorama', icon: 'globe', name: '生成全景图', desc: '2:1 等距柱状全景' },
  { id: 'outpaint', icon: 'expand', name: '扩图', desc: '按方向补全画面' },
];

export function ImageStudio({ node, src, initialTool = null, onClose, onSave, onGenerate, onError }) {
  const [tool, setTool] = useState(initialTool);
  const image = src || node?.resultUrl;
  const back = () => setTool(null);

  if (tool === 'crop' || tool === 'grid') {
    return <CropDialog src={image} mode={tool} onClose={back} onSave={onSave} onError={onError} />;
  }
  if (tool === 'annotate') {
    return <AnnotateDialog src={image} onClose={back} onSave={onSave} onError={onError} />;
  }
  if (tool === 'panorama') {
    return <PanoramaDialog node={node} src={image} onClose={back} onGenerate={onGenerate} />;
  }
  if (tool === 'outpaint') {
    return <OutpaintDialog node={node} src={image} onClose={back} onGenerate={onGenerate} />;
  }

  return createPortal(
    <div className="itk-backdrop" onWheel={(event) => event.stopPropagation()}>
      <div className="itk-dialog itk-menu" role="dialog" aria-modal="true" aria-label="图片工作室">
        <header className="itk-header">
          <Icon name="crop" size={18} />
          <div className="itk-heading">
            <strong>图片工作室</strong>
            <span>裁切、标注与全景扩图</span>
          </div>
          <button type="button" className="itk-icon" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="itk-menu-grid">
          {tools.map((item) => (
            <button type="button" key={item.id} className="itk-menu-card" onClick={() => setTool(item.id)} disabled={!image}>
              <Icon name={item.icon} size={20} />
              <strong>{item.name}</strong>
              <span>{item.desc}</span>
            </button>
          ))}
        </div>
        <footer className="itk-footer">
          <span role="status">{image ? '选择一项工具开始' : '当前节点还没有图片'}</span>
          <div><button type="button" onClick={onClose}>关闭</button></div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default ImageStudio;
