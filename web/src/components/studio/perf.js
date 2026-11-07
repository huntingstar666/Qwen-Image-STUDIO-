/**
 * 工作室性能探针（D18.1，方案 §17.4 / §17.6）。
 *
 * 开发开关：localStorage['wb.studio.perf'] = '1'，刷新后生效；关闭时所有方法零成本。
 *
 * 用法：
 *   const perf = createPerfProbe('studio.draw');
 *   const t0 = perf.start();
 *   ...渲染...
 *   perf.end(t0);            // 记录一帧耗时 + draw 次数
 *   perf.hit('maskTint');    // 额外计数（可选）
 *
 * 浏览器控制台：
 *   __wbPerf.snapshot()  // { heap, probes: [{ label, avg, max, frames, counts }] }
 *   __wbPerf.reset()     // 清空所有探针，便于分场景测量
 */

const FLAG = 'wb.studio.perf';

const registry = new Map();

export function isPerfEnabled() {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

function heapUsed() {
  return typeof performance !== 'undefined' && performance.memory
    ? performance.memory.usedJSHeapSize
    : null;
}

function summarize(probe) {
  const frames = probe.samples.length;
  const total = probe.samples.reduce((sum, value) => sum + value, 0);
  return {
    label: probe.label,
    enabled: probe.enabled,
    frames,
    avg: frames ? Number((total / frames).toFixed(2)) : 0,
    max: frames ? Number(Math.max(...probe.samples).toFixed(2)) : 0,
    counts: { ...probe.counts },
  };
}

export function createPerfProbe(label, { window = 60, enabled = isPerfEnabled() } = {}) {
  const probe = {
    label,
    enabled,
    samples: [],
    counts: Object.create(null),
    start() {
      return enabled ? performance.now() : 0;
    },
    end(startedAt) {
      if (!enabled) return 0;
      const ms = performance.now() - startedAt;
      probe.samples.push(ms);
      probe.hit('draw');
      if (probe.samples.length >= window) {
        const report = summarize(probe);
        const heap = heapUsed();
        console.info(
          `[perf] ${label} 平均 ${report.avg}ms / 最大 ${report.max}ms（${report.frames} 帧）`,
          report.counts,
          heap ? `heap ${(heap / 1048576).toFixed(1)}MB` : '',
        );
        probe.samples.length = 0;
      }
      return ms;
    },
    hit(kind, count = 1) {
      if (!enabled) return;
      probe.counts[kind] = (probe.counts[kind] || 0) + count;
    },
    reset() {
      probe.samples.length = 0;
      for (const key of Object.keys(probe.counts)) delete probe.counts[key];
    },
    snapshot() {
      return summarize(probe);
    },
  };
  registry.set(label, probe);
  return probe;
}

export function perfSnapshot() {
  return {
    at: Date.now(),
    heap: heapUsed(),
    probes: [...registry.values()].map(summarize),
  };
}

export function perfReset() {
  for (const probe of registry.values()) probe.reset();
}

if (typeof window !== 'undefined') {
  window.__wbPerf = {
    snapshot: perfSnapshot,
    reset: perfReset,
    probes: registry,
    enabled: isPerfEnabled(),
  };
}
