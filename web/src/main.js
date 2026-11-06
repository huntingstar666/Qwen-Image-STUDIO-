/**
 * 应用引导入口（index.html 里 <script type="module" src="/src/main.js"> 加载）。
 * 只做三件事：等待 DOM 就绪 → 启动 app → 兜底展示启动失败原因。
 */

import { boot } from './app.js';

function showFatal(message) {
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  viewport.innerHTML = `
    <div class="panel" style="max-width:640px;margin:40px auto">
      <div class="panel-body">
        <div class="notice bad">
          <div>
            <b>工作台启动失败</b><br />
            ${String(message).replace(/</g, '&lt;')}<br /><br />
            请检查浏览器控制台（F12）并确认后端服务 127.0.0.1:8700 正常运行。
          </div>
        </div>
      </div>
    </div>`;
}

function start() {
  boot().catch((err) => {
    console.error('[main] 启动失败', err);
    showFatal(err?.message || String(err));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
