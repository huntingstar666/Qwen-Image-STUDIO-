/**
 * 通用小部件：iOS 风格分段控件。
 * 按钮用 data-view 或 data-filter 标记取值，滑块由 CSS 变量驱动。
 */
export function initSegmented(container, onChange) {
  if (!container) return { get: () => "", set: () => {} };
  const buttons = [...container.querySelectorAll(".seg")];
  const thumb = container.querySelector(".seg-thumb");
  container.style.setProperty("--seg-n", String(Math.max(1, buttons.length)));

  const valueOf = (button) => button.dataset.view ?? button.dataset.filter ?? "";

  let current = "";
  const initial = buttons.find((button) => button.classList.contains("active")) || buttons[0];
  if (initial) current = valueOf(initial);
  if (thumb && initial) thumb.style.setProperty("--seg-i", String(buttons.indexOf(initial)));

  function paint(value) {
    const index = Math.max(0, buttons.findIndex((button) => valueOf(button) === value));
    buttons.forEach((button, position) => {
      const active = position === index;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (thumb) thumb.style.setProperty("--seg-i", String(index));
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const value = valueOf(button);
      if (value === current) return;
      current = value;
      paint(value);
      onChange(value);
    });
  });

  return {
    get: () => current,
    set(value) {
      current = value;
      paint(value);
    },
  };
}
