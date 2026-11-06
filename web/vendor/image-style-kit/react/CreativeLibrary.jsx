/**
 * 风格 / 运镜 / 滤镜库。
 *
 * 移植自原项目 `CreativeLibrary.tsx`，去掉了：
 * - `useNodeSidePanel` / `activateModal` / portal 定位（改为通用居中弹层）
 * - 后端 `/api/prompts/creative-library`（改为可注入 storage，默认 localStorage）
 * - 动态 import 目录（改为静态 `creativeCatalog`，也可通过 props 覆盖）
 *
 * 保留：分类 / 搜索 / 收藏 / 自定义前后缀 / 已选标签（tokens）。
 */
import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { creativeSelection, createLocalCreativeStorage, validCreativePreset } from '../src/creative.js';
import { creativeCatalog } from '../src/catalogs.js';
import MjStyleLibrary from './MjStyleLibrary.jsx';

const labels = { style: '风格', motion: '运镜', filter: '滤镜', custom: '自定义' };
const icons = { style: 'palette', motion: 'film', filter: 'sliders', custom: 'sliders' };

/** 默认存储。宿主可传入自己的 storage（load / save）。 */
const fallbackStorage = createLocalCreativeStorage();

function Preview({ preset, active, resolveAssetUrl }) {
  const [failed, setFailed] = useState(false);
  const video = useRef(null);
  useEffect(() => {
    if (active && video.current) video.current.play().catch(() => setFailed(true));
  }, [active]);
  if (!preset.preview) return null;
  const src = resolveAssetUrl ? resolveAssetUrl(preset.preview) : preset.preview;
  return (
    <>
      {(!preset.poster || !active) && <img src={resolveAssetUrl ? resolveAssetUrl(preset.poster || preset.preview) : preset.poster || preset.preview} alt="" loading="lazy" decoding="async" />}
      {active && preset.poster && !failed && (
        <video ref={video} src={src} muted loop playsInline preload="auto" onError={() => setFailed(true)} />
      )}
    </>
  );
}

/** 已加入提示词的预设标签，点击移除。 */
export function CreativePromptTokens({ node, onUpdate, disabled = false }) {
  const selected = creativeSelection(node.creativePresets);
  const tabs = node.type.toLowerCase() === 'video' ? ['style', 'motion', 'filter', 'custom'] : ['style', 'filter', 'custom'];
  if (!tabs.some((tab) => selected[tab])) return null;
  return (
    <div className="af-creative-tools af-creative-prompt-tokens" aria-label="已加入提示词的预设" onClick={(event) => event.stopPropagation()}>
      {tabs.map(
        (tab) =>
          selected[tab] && (
            <button
              className="af-creative-tag"
              title={[selected[tab].prefix, selected[tab].prompt].filter(Boolean).join('\n')}
              type="button"
              key={tab}
              disabled={disabled}
              aria-label={`移除${labels[tab]}：${selected[tab].name}`}
              onClick={() => onUpdate({ creativePresets: { ...selected, [tab]: null } })}
            >
              {selected[tab].name}
              <span aria-hidden>×</span>
            </button>
          ),
      )}
    </div>
  );
}

/** MJ 风格码状态提示（原实现依赖 tiptap 标签解析，这里按参数前缀计数）。 */
export function MjStyleStatus({ prompt }) {
  const count = (String(prompt || '').match(/(?:^|\s)--(?:sref|profile|p|personalize)(?=\s|$)/gi) || []).length;
  if (!count) return null;
  return (
    <div className="mgn-mj-status" role="status" title="风格码会自动放在提示词末尾">
      风格码已加入{count > 1 ? `（${count} 组）` : ''} · 自动放在末尾
    </div>
  );
}

/** 风格 / 运镜 / 滤镜入口按钮组，外加 MJ 码图馆入口。 */
export function CreativeLibraryTools({ node, onUpdate, disabled = false, catalog = creativeCatalog, mjStyleCatalog, storage, resolveAssetUrl, onInsertText }) {
  const [open, setOpen] = useState(null);
  const selected = creativeSelection(node.creativePresets);
  const tabs = node.type.toLowerCase() === 'video' ? ['style', 'motion', 'filter', 'custom'] : ['style', 'filter', 'custom'];
  const choose = (slot, preset) => {
    setOpen(null);
    if (disabled) return;
    if (!preset) {
      onUpdate({ creativePresets: { ...selected, [slot]: null } });
      return;
    }
    onUpdate({ creativePresets: { ...selected, [slot]: preset } });
  };
  return (
    <div className="af-creative-tools" data-mgn-creative-tools="true" onClick={(event) => event.stopPropagation()}>
      {tabs
        .filter((tab) => tab !== 'custom')
        .map((tab) => (
          <Fragment key={tab}>
            <button type="button" disabled={disabled} aria-haspopup="dialog" onPointerDown={(event) => event.preventDefault()} onClick={() => setOpen(tab)}>
              <Icon name={icons[tab]} size={14} /> {labels[tab]}
            </button>
            {tab === 'style' && node.type.toLowerCase() === 'image' && (
              <button type="button" disabled={disabled} aria-haspopup="dialog" onPointerDown={(event) => event.preventDefault()} onClick={() => setOpen('mj')}>
                MJ 码图
              </button>
            )}
          </Fragment>
        ))}
      {open === 'mj' && (
        <MjStyleLibrary
          key={node.id}
          catalog={mjStyleCatalog}
          resolveAssetUrl={resolveAssetUrl}
          onClose={() => setOpen(null)}
          onChoose={(preset) => {
            setOpen(null);
            if (disabled) return;
            const text = [preset.prefix, preset.prompt].filter(Boolean).join('\n');
            if (onInsertText) onInsertText(text);
            else onUpdate({ prompt: [node.prompt, text].filter(Boolean).join('\n') });
          }}
        />
      )}
      {open && open !== 'mj' && (
        <CreativeLibraryPanel
          key={`${node.id}:${open}`}
          initialTab={open}
          tabs={tabs}
          selected={selected}
          disabled={disabled}
          catalog={catalog}
          storage={storage || fallbackStorage}
          resolveAssetUrl={resolveAssetUrl}
          onClose={() => setOpen(null)}
          onChoose={choose}
        />
      )}
    </div>
  );
}

const CATEGORY_ORDER = {
  style: ['真人风格', '2D风格', '3D风格'],
  motion: ['基础运镜', '组合运镜', '高阶运镜'],
  filter: ['通用', '人像质感'],
};

function CreativeLibraryPanel({ initialTab, tabs, selected, disabled, catalog, storage, resolveAssetUrl, onClose, onChoose }) {
  const [tab, setTab] = useState(initialTab);
  const [category, setCategory] = useState('全部');
  const [search, setSearch] = useState('');
  const [saved, setSaved] = useState({ favorites: [], custom: [] });
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(null);
  const [name, setName] = useState(selected.custom?.name || '');
  const [prefix, setPrefix] = useState(selected.custom?.prefix || '');
  const [suffix, setSuffix] = useState(selected.custom?.prompt || '');
  const [customId, setCustomId] = useState(selected.custom?.id || '');

  useEffect(() => {
    let alive = true;
    storage
      .load()
      .then((data) => {
        if (alive) {
          setSaved(data);
          setReady(true);
        }
      })
      .catch(() => alive && setError('收藏和自定义预设暂时无法读取。'));
    return () => {
      alive = false;
    };
  }, [storage]);

  useEffect(() => {
    const key = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  async function save(next) {
    if (!ready || saving) return false;
    setSaving(true);
    try {
      await storage.save(next);
      setSaved(next);
      setError('');
      return true;
    } catch {
      setError('未能保存预设，请检查存储空间后重试。');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function applyCustom(persist) {
    if (!name.trim() || !(prefix.trim() || suffix.trim())) {
      setError('请填写名称和至少一段提示词。');
      return;
    }
    const preset = {
      id: customId || `custom-${Date.now().toString(36)}`,
      kind: 'style',
      category: '自定义',
      name: name.trim(),
      description: '自定义前后缀',
      prefix: prefix.trim(),
      prompt: suffix.trim(),
    };
    if (!validCreativePreset(preset)) {
      setError('名称最多 80 字，前后缀各最多 12000 字。');
      return;
    }
    if (persist) {
      if (await save({ ...saved, custom: [...saved.custom.filter((item) => item.id !== preset.id), preset] })) setCustomId(preset.id);
    } else onChoose('custom', preset);
  }

  const categories = ['全部', '收藏', ...(CATEGORY_ORDER[tab] || [])];
  const items = useMemo(
    () =>
      catalog.filter(
        (preset) =>
          preset.kind === tab &&
          (category === '全部' || (category === '收藏' && saved.favorites.includes(preset.id)) || preset.category === category) &&
          `${preset.name} ${preset.description}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [catalog, tab, category, search, saved.favorites],
  );

  return createPortal(
    <div className="af-creative-backdrop" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="af-creative-panel" role="dialog" aria-modal="true" aria-label="创作预设库">
        <header className="af-creative-header">
          <div className="af-creative-tabs">
            {tabs.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={tab === item}
                onClick={() => {
                  setTab(item);
                  setCategory('全部');
                  setSearch('');
                  setActive(null);
                }}
              >
                {labels[item]}
              </button>
            ))}
          </div>
          {tab !== 'custom' && (
            <input
              type="search"
              aria-label="搜索预设"
              placeholder={`搜索${labels[tab]}`}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setActive(null);
              }}
            />
          )}
          <button type="button" onClick={onClose} className="af-creative-close" title="关闭创作预设库" aria-label="关闭创作预设库">
            <Icon name="close" size={18} />
          </button>
        </header>
        {tab !== 'custom' ? (
          <>
            <nav className="af-creative-categories" aria-label="预设分类">
              {categories.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={category === item}
                  onClick={() => {
                    setCategory(item);
                    setActive(null);
                  }}
                >
                  {item}
                </button>
              ))}
            </nav>
            <div className="af-creative-grid" onScroll={() => setActive(null)}>
              {items.map((preset) => (
                <article
                  key={preset.id}
                  className={`af-creative-card${selected[tab]?.id === preset.id ? ' is-selected' : ''}`}
                  onMouseEnter={() => setActive(preset.id)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(preset.id)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
                  }}
                >
                  <button
                    type="button"
                    className="af-creative-choose"
                    aria-label={`应用${preset.name}`}
                    aria-pressed={selected[tab]?.id === preset.id}
                    disabled={disabled}
                    title={preset.description}
                    onClick={() => onChoose(tab, preset)}
                  >
                    <Preview preset={preset} active={active === preset.id} resolveAssetUrl={resolveAssetUrl} />
                    <span className="af-creative-title">{preset.name}</span>
                  </button>
                  <button
                    className="af-creative-star"
                    type="button"
                    disabled={!ready || saving}
                    aria-label={`${saved.favorites.includes(preset.id) ? '取消收藏' : '收藏'}${preset.name}`}
                    aria-pressed={saved.favorites.includes(preset.id)}
                    onClick={() =>
                      save({
                        ...saved,
                        favorites: saved.favorites.includes(preset.id) ? saved.favorites.filter((id) => id !== preset.id) : [...saved.favorites, preset.id],
                      })
                    }
                  >
                    <Icon name="star" size={16} />
                  </button>
                </article>
              ))}
              {!items.length && (
                <p className="af-creative-empty">
                  {error || (!catalog.length ? '正在加载预设…' : category === '收藏' ? '点击卡片上的星标，收藏常用预设。' : '没有匹配的预设，请换个关键词。')}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="af-creative-custom">
            <label>
              已保存预设
              <select
                aria-label="已保存预设"
                value={customId}
                onChange={(event) => {
                  const preset = saved.custom.find((item) => item.id === event.target.value);
                  setCustomId(preset?.id || '');
                  setName(preset?.name || '');
                  setPrefix(preset?.prefix || '');
                  setSuffix(preset?.prompt || '');
                }}
              >
                <option value="">新建预设</option>
                {saved.custom.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              名称
              <input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="给预设起个名字" />
            </label>
            <label>
              前缀内容
              <textarea maxLength={12000} value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="生成时放在正文之前" />
            </label>
            <label>
              后缀内容
              <textarea maxLength={12000} value={suffix} onChange={(event) => setSuffix(event.target.value)} placeholder="生成时放在正文之后" />
            </label>
            <div className="af-creative-actions">
              {customId && (
                <button
                  type="button"
                  onClick={() => {
                    save({ ...saved, custom: saved.custom.filter((preset) => preset.id !== customId) });
                    setCustomId('');
                  }}
                >
                  删除预设
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setName('');
                  setPrefix('');
                  setSuffix('');
                  setCustomId('');
                }}
              >
                清空
              </button>
              <button type="button" disabled={!ready || saving} onClick={() => applyCustom(true)}>
                保存预设
              </button>
              <button type="button" className="primary" disabled={disabled} onClick={() => applyCustom(false)}>
                应用
              </button>
            </div>
          </div>
        )}
        <footer className="af-creative-footer">
          <span role="status">
            {error || (tab === 'custom' ? '前后缀随节点保存，不修改正文。' : `${items.length} 个预设 · 收藏保存在本机${tab === 'motion' ? ' · 悬停预览运镜' : ''}`)}
          </span>
          {selected[tab] && (
            <button type="button" disabled={disabled} onClick={() => onChoose(tab, null)}>
              清除{labels[tab]}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default CreativeLibraryTools;

