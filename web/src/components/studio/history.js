/**
 * 撤销 / 重做栈（D7.4）。
 *
 * 只存状态快照，不认识文档内容：`push` 入栈、`undo/redo` 返回该恢复的状态。
 * 同时限制步数与总字节预算（4K 蒙版单张约 67MB，光靠步数容易把内存吃满）。
 */

/**
 * @param {{ limit?: number, budget?: number }} [options]
 * @returns {{
 *   past: object[], future: object[], bytes: number,
 *   canUndo: boolean, canRedo: boolean,
 *   push: (state: object) => object,
 *   undo: () => object|null, redo: () => object|null,
 *   clear: () => void,
 * }}
 */
export function createHistory({ limit = 30, budget = 256 * 1024 * 1024 } = {}) {
  const past = [];
  const future = [];
  let bytes = 0;
  const sizeOf = (state) => Number(state?.bytes) || 0;

  const trim = () => {
    while (past.length > limit) bytes -= sizeOf(past.shift());
    // 至少保留「初始 + 最新」两帧，否则撤销会直接失效。
    while (past.length > 2 && bytes > budget) bytes -= sizeOf(past.shift());
  };

  return {
    past,
    future,
    get bytes() {
      return bytes;
    },
    get canUndo() {
      return past.length > 1;
    },
    get canRedo() {
      return future.length > 0;
    },
    push(state) {
      past.push(state);
      bytes += sizeOf(state);
      trim();
      future.length = 0;
      return state;
    },
    /** @returns {object|null} 需要恢复到的状态 */
    undo() {
      if (past.length <= 1) return null;
      const popped = past.pop();
      bytes -= sizeOf(popped);
      future.push(popped);
      return past[past.length - 1];
    },
    /** @returns {object|null} 需要恢复到的状态 */
    redo() {
      if (!future.length) return null;
      const state = future.pop();
      past.push(state);
      bytes += sizeOf(state);
      return state;
    },
    clear() {
      past.length = 0;
      future.length = 0;
      bytes = 0;
    },
  };
}
