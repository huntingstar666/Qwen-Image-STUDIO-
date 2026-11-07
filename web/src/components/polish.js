/**
 * 提示词润色按钮的公共交互（文生图 / 图像编辑共用）。
 * 流程：POST /api/polish → 弹出「原文 / 润色后」对比 → 用户接受或回退。
 * 显示模型、耗时、fallback、wh_ratio；文生图页在建议比例可匹配时提供一键切换。
 */

import { api } from '../api.js';
import { openModal } from './modal.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';
import { escapeHtml, fmtNum } from '../utils.js';

/**
 * @param {object} options
 * @param {string} options.prompt 原始提示词
 * @param {'t2i'|'edit'} options.mode
 * @param {string|null} [options.model] Ollama 模型
 * @param {string|null} [options.imageModel] 图像模型档案 id（qwen / moss），决定用哪套提示词工程
 * @param {string} [options.layoutHint] 追加给润色模型的补充说明（不会写入最终提示词以外的地方）
 * @param {string} [options.styleHint] 已选风格 / 滤镜 / 视角摘要，供润色模型对齐语气但避免重复
 * @param {HTMLButtonElement} [options.button] 触发按钮（用于 loading 状态）
 * @param {Array<{id:string,w:number,h:number}>} [options.ratios] 可匹配的比例表
 * @param {{width:number,height:number}} [options.targetSize] 目标尺寸，供模型判断构图
 * @param {{image:string,summary?:string,label?:string}} [options.pose] 姿态参考图（会一并交给视觉模型）
 * @param {(text: string, result: object) => void} options.onAccept 采用润色结果
 */
export async function polishWithDialog({
  prompt,
  mode = 't2i',
  model = null,
  imageModel = null,
  layoutHint = '',
  styleHint = '',
  button = null,
  ratios = [],
  targetSize = null,
  pose = null,
  onAccept,
}) {
  const text = String(prompt || '').trim();
  if (!text) {
    toastWarn('请先填写提示词，再使用润色');
    return;
  }
  const originalHtml = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>润色中…';
  }
  try {
    const payload = { prompt: text, mode, model: model || null };
    if (imageModel) payload.image_model = imageModel;
    const hints = [layoutHint, styleHint]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (hints.length) payload.prompt = `${text}\n\n（补充说明：${hints.join(' ')}）`;
    if (targetSize) payload.target_size = targetSize;
    if (pose?.image) {
      payload.pose = {
        image: pose.image,
        summary: pose.summary || '',
        label: pose.label || '',
      };
    }
    const result = await api.polish(payload);
    showCompareDialog({
      result,
      original: text,
      ratios,
      onAccept,
      mode,
      poseAttached: Boolean(pose?.image),
    });
  } catch (err) {
    toastError(err, '提示词润色失败');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = originalHtml;
    }
  }
}

function showCompareDialog({ result, original, ratios, onAccept, mode, poseAttached = false }) {
  const rewritten = String(result?.rewritten_prompt || '').trim();
  const whRatio = String(result?.wh_ratio || '').trim();
  const fallback = Boolean(result?.fallback);

  const meta = [];
  if (result?.model) meta.push(`<span class="badge info">${escapeHtml(result.model)}</span>`);
  if (result?.elapsed_ms != null) {
    meta.push(`<span class="badge">耗时 ${(Number(result.elapsed_ms) / 1000).toFixed(1)}s</span>`);
  }
  if (poseAttached) meta.push('<span class="badge info">已附带姿态参考</span>');
  if (whRatio) meta.push(`<span class="badge info">建议比例 ${escapeHtml(whRatio)}</span>`);
  if (result?.ratio_follow != null) {
    meta.push(`<span class="badge">${result.ratio_follow ? '会跟随建议比例' : '保持原比例'}</span>`);
  }
  if (fallback) meta.push('<span class="badge warn">Ollama 不可用 · 已返回原文</span>');

  const ratioMatch = (ratios || []).find((ratio) => String(ratio.id).replace(/\s+/g, '') === whRatio.replace(/\s+/g, ''));

  const content = document.createElement('div');
  content.innerHTML = `
    <div class="compare-grid">
      <div class="compare-box">
        <h4>原文</h4>
        <div class="compare-text">${escapeHtml(original)}</div>
      </div>
      <div class="compare-box after">
        <h4>润色后</h4>
        <div class="compare-text">${escapeHtml(rewritten || '（模型没有返回润色文本）')}</div>
      </div>
    </div>
    <div class="compare-meta">${meta.join('')}</div>
    ${
      ratioMatch && rewritten
        ? `<label class="switch">
             <input type="checkbox" data-ref="applyRatio" checked />
             <span class="switch-track"></span>
             <span class="switch-label">同时切换到建议比例 ${escapeHtml(ratioMatch.id)}<small>${fmtNum(ratioMatch.w)} × ${fmtNum(ratioMatch.h)}</small></span>
           </label>`
        : ''
    }
    ${fallback ? '<div class="notice warn">Ollama 未连接或调用失败，本次润色回退为原文。可稍后重试。</div>' : ''}
    ${mode === 'edit' ? '<div class="notice info">图像编辑的润色提示词只改写编辑指令，不会改变参考图本身。</div>' : ''}`;

  openModal({
    title: '提示词润色对比',
    subtitle: '采用前可以先对比原文与润色结果',
    size: 'lg',
    content,
    actions: [
      { label: '回退原文', kind: 'ghost' },
      {
        label: '采用润色结果',
        kind: 'primary',
        onClick: ({ body }) => {
          if (!rewritten) {
            toastWarn('润色结果为空，已保留原文');
            return false;
          }
          const applyRatio = Boolean(body.querySelector('[data-ref="applyRatio"]')?.checked);
          onAccept?.(rewritten, result, { applyRatio: applyRatio && Boolean(ratioMatch), ratio: ratioMatch || null });
          toastSuccess('已采用润色后的提示词');
        },
      },
    ],
  });
}
