/**
 * Midjourney 提示词规整。
 * 与原项目 `src/shared/midjourneyPrompt.js` 行为一致。
 */

/** 把所有参数块整理到提示词末尾，sref / profile 支持叠加。 */
export function normalizeMidjourneyPrompt(value) {
  const text = String(value || '');
  const flags = [...text.matchAll(/(?:^|\s)--([a-z][a-z-]*)(?=\s|$)/gi)];
  if (!flags.length) return text.trim();
  const parameters = new Map();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    let name = flag[1].toLowerCase();
    if (name === 'preview') continue;
    if (name === 'p' || name === 'personalize') name = 'profile';
    const valuePart = text.slice(flag.index + flag[0].length, flags[index + 1]?.index ?? text.length).trim();
    if (name === 'sref' || name === 'profile') {
      const previous = parameters.get(name) || '';
      parameters.set(name, [...new Set(`${previous} ${valuePart}`.split(/\s+/).filter(Boolean))].join(' '));
    } else {
      // 标量参数不能叠加，最后一次显式选择生效。
      parameters.set(name, valuePart);
    }
  }
  const suffix = [...parameters].map(([name, value]) => `--${name}${value ? ` ${value}` : ''}`).join(' ');
  return [text.slice(0, flags[0].index).trim(), suffix].filter(Boolean).join('\n');
}

/** 去掉仅用于本地预览的参数。 */
export function removeMidjourneyPreview(value) {
  return String(value || '').replace(/(?:^|\s)--preview(?=\s|$)/gi, '').trim();
}

