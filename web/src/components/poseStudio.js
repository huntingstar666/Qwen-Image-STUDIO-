/**
 * 姿态工作室：内嵌 ComfyUI-Gaoshang-Pose 的 3D 自由姿势编辑器（freepose）。
 *
 * 为什么用 iframe：那套编辑器是 VNCCS Pose Studio 的完整 3D 内核
 * （MakeHuman 人体 + 骨骼 IK + OpenPose 一键摆姿），自带 Three.js 与 86MB 人体数据，
 * 复刻一遍不现实。它本身就支持 `?embedded` 模式，通过 postMessage 和宿主页面通信：
 * - 宿主 → 编辑器：{type:'gaoshang-load', payload:{pose_json, extra_prompt, referencePreview}}
 * - 编辑器 → 宿主：{type:'gaoshang-ready' | 'gaoshang-apply' | 'gaoshang-close'}
 *
 * 应用姿态时不用编辑器现成的截图，而是直接调 `freePose.viewer.capture()`：
 * 正面（yaw 0 / pitch 0）、纯白环境光、白底人偶 —— 与 VNCCS 姿态 LoRA 的训练分布一致。
 * 这张图作为 image1 提交，只提供动作、朝向与构图，提示词负责场景、服装和光影。
 *
 * 资源与同步见 scripts/sync_pose3d_assets.ps1，静态目录 web/vendor/pose3d。
 */

import { openModal } from './modal.js';
import { toastError } from './toast.js';

const FRAME_SRC = '/vendor/pose3d/editor/freepose.html?embedded';
const CAPTURE_LIGHTS = [{ type: 'ambient', color: '#ffffff', intensity: 1.0 }];
const CAPTURE_BACKGROUND = [255, 255, 255];
const DEFAULT_SIZE = 1024;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round16 = (value) => clamp(Math.round(Number(value) / 16) * 16, 64, 4096);

/** 摆好姿势后，编辑器里那个按钮叫「应用到节点」——换成本应用的措辞。 */
function localizeFrame(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.title = '姿态参考';
    const apply = doc.getElementById('apply-editor');
    if (apply) apply.textContent = '应用姿态';
    const cancel = doc.getElementById('cancel-editor');
    if (cancel) cancel.textContent = '取消';
  } catch {
    /* 跨域或文档已卸载：标签保持原样，不影响功能 */
  }
}

export function openPoseStudio({ initial = null, onApply, onClear } = {}) {
  let strength = clamp(Number(initial?.strength ?? 0.85), 0.3, 1.2);
  let useLora = initial?.useLora !== false;
  let applying = false;

  const content = document.createElement('div');
  content.className = 'pose3d';
  content.innerHTML = `
    <iframe class="pose3d-frame" title="3D 姿态编辑器" allow="clipboard-write"></iframe>
    <div class="pose3d-bar">
      <label class="pose3d-strength">
        姿态跟随强度
        <input type="range" min="0.3" max="1.2" step="0.05" value="${strength}" />
        <span class="mono" data-ref="strengthVal">${strength.toFixed(2)}</span>
      </label>
      <label class="pose3d-check">
        <input type="checkbox" ${useLora ? 'checked' : ''} data-ref="useLora" />
        <span>启用姿态 LoRA</span>
      </label>
      <span class="pose3d-hint">白底人偶作为 image1 提交，只提供动作、朝向与构图。</span>
      <button class="btn ghost sm" type="button" data-ref="clear">清除姿态</button>
    </div>`;

  const frame = content.querySelector('.pose3d-frame');
  const strengthInput = content.querySelector('input[type="range"]');
  const strengthVal = content.querySelector('[data-ref="strengthVal"]');
  const useLoraInput = content.querySelector('[data-ref="useLora"]');

  strengthInput.addEventListener('input', () => {
    strength = Number(strengthInput.value);
    strengthVal.textContent = strength.toFixed(2);
  });
  useLoraInput.addEventListener('change', () => {
    useLora = useLoraInput.checked;
  });

  const origin = location.origin;

  async function applyFromFrame(payload) {
    if (applying) return;
    const api = frame.contentWindow?.freePose;
    if (!api?.viewer) {
      toastError(new Error('3D 编辑器尚未就绪，等人体数据加载完成再点「应用姿态」'), '姿态应用失败');
      return;
    }
    applying = true;
    try {
      await api.viewer.waitForCaptureReady();
      const width = round16(api.doc?.width || DEFAULT_SIZE);
      const height = round16(api.doc?.height || DEFAULT_SIZE);
      api.viewer.updateLights(CAPTURE_LIGHTS);
      // 单人时把人偶染成纯白，对齐 VNCCS LoRA 的训练图；多人保留颜色以便按颜色分人
      if ((api.people?.length || 1) === 1) api.viewer.setActiveCharacterAppearance({ color: '#ffffff' });
      const dataUrl = api.viewer.capture(width, height, 1, CAPTURE_BACKGROUND, 0, 0, 0, 0);
      if (!dataUrl) throw new Error('人偶截图失败，请稍后重试');
      const name = String(api.doc?.openpose?.name || '').trim();
      onApply?.({
        dataUrl,
        width,
        height,
        pose3d: payload?.pose_json || '',
        label: name || '3D 自定义姿态',
        summary: name ? `三维人偶姿态（${name}）` : '三维人偶自定义姿态',
        strength: Number(strength.toFixed(2)),
        useLora,
      });
      modal.close();
    } catch (error) {
      toastError(error, '姿态应用失败');
    } finally {
      applying = false;
    }
  }

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== origin) return;
    const type = event.data?.type;
    if (type === 'gaoshang-ready') {
      frame.contentWindow.postMessage({
        type: 'gaoshang-load',
        payload: {
          pose_json: initial?.pose3d || '',
          extra_prompt: '',
          referencePreview: initial?.referencePreview || null,
        },
      }, origin);
      return;
    }
    if (type === 'gaoshang-apply') {
      void applyFromFrame(event.data.payload);
      return;
    }
    if (type === 'gaoshang-close') modal.close();
  };

  const modal = openModal({
    title: '姿态参考',
    subtitle: '3D 人偶摆姿：拖着关节摆好动作，正面白底人偶会作为 image1',
    content,
    size: 'lg',
    dialogClass: 'pose3d-dialog',
    hideFooter: true,
    onClose: () => {
      window.removeEventListener('message', onMessage);
      try {
        frame.src = 'about:blank';
      } catch {
        /* 文档已卸载 */
      }
    },
  });

  content.querySelector('[data-ref="clear"]').addEventListener('click', () => {
    onClear?.();
    modal.close();
  });

  frame.addEventListener('load', () => localizeFrame(frame));
  window.addEventListener('message', onMessage);
  frame.src = FRAME_SRC;

  return modal;
}
