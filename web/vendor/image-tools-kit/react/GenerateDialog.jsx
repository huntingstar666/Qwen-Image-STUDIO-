/**
 * 全景生成 / 扩图 对话框。
 * 参数构造复用 `src/prompt.js`，真正的建节点与连线由宿主的 `onGenerate` 完成。
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { buildOutpaintDraft, buildPanoramaDraft, outpaintDirections, panoramaPrompt } from '../src/prompt.js';
import { Icon } from './Icon.jsx';

function Shell({ title, subtitle, icon, children, footer, onClose }) {
  return createPortal(
    <div className="itk-backdrop" onWheel={(event) => event.stopPropagation()}>
      <div className="itk-dialog itk-generate" role="dialog" aria-modal="true" aria-label={title}>
        <header className="itk-header">
          <Icon name={icon} size={18} />
          <div className="itk-heading">
            <strong>{title}</strong>
            <span>{subtitle}</span>
          </div>
          <button type="button" className="itk-icon" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="itk-body">{children}</div>
        <footer className="itk-footer">{footer}</footer>
      </div>
    </div>,
    document.body,
  );
}

export function PanoramaDialog({ node, src, onClose, onGenerate }) {
  const [prompt, setPrompt] = useState(panoramaPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const image = src || node?.resultUrl;

  async function generate() {
    setBusy(true);
    setError('');
    try {
      await onGenerate(buildPanoramaDraft({ ...node, resultUrl: image }, { prompt }));
      onClose?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="生成全景图"
      subtitle="输出 2:1 的等距柱状全景贴图"
      icon="globe"
      onClose={onClose}
      footer={
        <>
          <span role="status">{error || '需要图生图模型，且会新建一个节点。'}</span>
          <div>
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="itk-primary" disabled={busy || !image} onClick={generate}>
              {busy ? '提交中…' : '生成全景图'}
            </button>
          </div>
        </>
      }
    >
      {image ? <img className="itk-source" src={image} alt="参考图" /> : <p role="alert">没有可用的参考图。</p>}
      <label className="itk-field">
        提示词
        <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={12000} />
      </label>
      <p className="itk-note">全景提示词已内置：360°×180°、左右无缝、天地闭合、保持原图风格。</p>
    </Shell>
  );
}

export function OutpaintDialog({ node, src, onClose, onGenerate, aspectRatios }) {
  const [direction, setDirection] = useState('right');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const image = src || node?.resultUrl;

  async function generate() {
    setBusy(true);
    setError('');
    try {
      await onGenerate(
        buildOutpaintDraft(
          { ...node, resultUrl: image },
          { angle: outpaintDirections[direction], aspectRatio, prompt, aspectRatios },
        ),
      );
      onClose?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="扩图"
      subtitle="按方向补全画面，提示词可留空"
      icon="expand"
      onClose={onClose}
      footer={
        <>
          <span role="status">{error || '保持主体不变，只补全目标方向。'}</span>
          <div>
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="itk-primary" disabled={busy || !image} onClick={generate}>
              {busy ? '提交中…' : '生成扩图'}
            </button>
          </div>
        </>
      }
    >
      {image ? <img className="itk-source" src={image} alt="参考图" /> : <p role="alert">没有可用的参考图。</p>}
      <div className="itk-directions">
        {Object.keys(outpaintDirections).map((key) => (
          <button type="button" key={key} aria-pressed={direction === key} onClick={() => setDirection(key)}>
            {{ left: '向左', right: '向右', up: '向上', down: '向下' }[key]}
          </button>
        ))}
      </div>
      <label className="itk-field">
        目标比例
        <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
          {['16:9', '21:9', '3:2', '4:3', '1:1', '9:16', '2:1'].map((ratio) => (
            <option key={ratio} value={ratio}>{ratio}</option>
          ))}
        </select>
      </label>
      <label className="itk-field">
        补充提示词（可选）
        <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：右侧延展为街道与建筑" />
      </label>
    </Shell>
  );
}

export default PanoramaDialog;
