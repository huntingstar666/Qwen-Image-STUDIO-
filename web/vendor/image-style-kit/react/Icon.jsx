/** 独立包内置的极简图标（无第三方依赖）。 */
import React from 'react';

const ICON_PATHS = {
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M6 9l6 6 6-6',
  star: 'M12 4l2.4 5 5.6.8-4 4 .9 5.6L12 16.8 7.1 19.4 8 13.8l-4-4 5.6-.8z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M20 20l-4-4',
  back: 'M11 5l-7 7 7 7 M4 12h16',
  palette: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-3.3-4-6-9-6 M7 11h.01 M9 7h.01 M14 7h.01',
  film: 'M4 5h16v14H4z M8 5v14 M16 5v14 M4 9h4 M4 15h4 M16 9h4 M16 15h4',
  sliders: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5v4 M9 15v4',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  refresh: 'M20 11a8 8 0 1 0-2 6 M20 5v6h-6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 8h.01 M12 11v6',
};

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg
      className={`isk-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(ICON_PATHS[name] || ICON_PATHS.info).split(' M').map((path, index) => (
        <path key={index} d={index === 0 ? path : `M${path}`} />
      ))}
    </svg>
  );
}

export default Icon;
