/**
 * 「视频工作台」页面。
 *
 * 视频工作台是独立服务（默认 127.0.0.1:8730），这里只做内嵌：
 * - iframe 加载 `?embed=1`，由工作台自己隐藏顶栏、跟随主项目主题；
 * - 顶部提供「新窗口打开 / 刷新」，服务未启动时给出明确提示。
 */

const VIDEO_BASE = "http://127.0.0.1:8730";
let currentBuild = "";

function iframeUrl() {
  const dark = document.documentElement.dataset.theme === "dark";
  const build = currentBuild ? `&build=${encodeURIComponent(currentBuild)}` : "";
  return `${VIDEO_BASE}/?embed=1&theme=${dark ? "dark" : "light"}${build}`;
}

export function createVideoStudioPage(host) {
  host.innerHTML = `
    <div class="page page-video">
      <div class="vs-toolbar">
        <span class="vs-title">视频工作台<em>audio → storyboard → video</em></span>
        <span class="vs-status" data-ref="status">正在连接 8730…</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" type="button" data-ref="reload">刷新画面</button>
        <a class="btn ghost sm" data-ref="open" href="${VIDEO_BASE}/" target="_blank" rel="noopener">新窗口打开</a>
      </div>
      <div class="vs-stage">
        <iframe class="vs-frame" data-ref="frame" title="视频工作台" allow="autoplay"></iframe>
        <div class="vs-offline" data-ref="offline" hidden>
          <strong>视频工作台没有启动</strong>
          <p>在项目目录运行下面这条命令，然后点「刷新画面」：</p>
          <code>python -m video_studio.serve --port 8730</code>
        </div>
      </div>
    </div>
  `;

  const frame = host.querySelector('[data-ref="frame"]');
  const status = host.querySelector('[data-ref="status"]');
  const offline = host.querySelector('[data-ref="offline"]');

  const load = () => {
    offline.hidden = true;
    status.textContent = "正在连接 8730…";
    frame.src = iframeUrl();
  };

  const showOffline = () => {
    status.textContent = "未连接";
    offline.hidden = false;
  };

  const probe = () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    return fetch(`${VIDEO_BASE}/api/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .finally(() => clearTimeout(timer));
  };

  frame.addEventListener("load", () => {
    status.textContent = "已连接 · 127.0.0.1:8730";
  });
  const applyHealth = (health) => {
    if (health && health.build) currentBuild = String(health.build);
    load();
  };
  host.querySelector('[data-ref="reload"]').addEventListener("click", () => {
    probe().then(applyHealth).catch(showOffline);
  });

  // 服务不在时 iframe 会停在浏览器错误页，先探活再加载，给出人话提示
  probe().then(applyHealth).catch(showOffline);

  return {
    onShow() {
      // 工作台前端有更新时，切回本页自动重载 iframe，避免一直跑旧脚本
      probe().then((health) => {
        const build = String((health && health.build) || "");
        if (build && build !== currentBuild) {
          currentBuild = build;
          load();
        }
      }).catch(() => {});
    },
    destroy() {
      frame.src = "about:blank";
    },
  };
}
