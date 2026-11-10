/**
 * 撤销 / 重做栈（D7.4）+ 命名快照（D12.3）。
 *
 * 只存状态快照，不认识文档内容：`push` 入栈、`undo/redo` 返回该恢复的状态。
 * 同时限制步数与总字节预算（4K 蒙版单张约 67MB，光靠步数容易把内存吃满）。
 * 命名快照单独存放，不占撤销步数；即使历史栈被裁剪，快照仍可回跳。
 */

let snapshotSeq = 0;
/** 命名快照上限：每张都持有完整状态克隆，太多会吃满内存。 */
const MAX_SNAPSHOTS = 20;

/**
 * @param {{ limit?: number, budget?: number }} [options]
 * @returns {{
 *   past: object[], future: object[], snapshots: object[], bytes: number,
 *   canUndo: boolean, canRedo: boolean,
 *   push: (state: object) => object,
 *   undo: () => object|null, redo: () => object|null,
 *   clear: () => void,
 *   addSnapshot: (state: object, name?: string) => object,
 *   removeSnapshot: (id: string) => boolean,
 *   findSnapshot: (id: string) => object|null,
 * }}
 */
export function createHistory({ limit = 30, budget = 256 * 1024 * 1024 } = {}) {
  const past = [];
  const future = [];
  const snapshots = [];
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
    snapshots,
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
    /**
     * 把当前状态另存为命名快照（不改变撤销栈）。
     * 快照同样占内存（4K 图一张约 30MB+），计入 bytes 并限制数量，
     * 否则连续存十几张会把内存吃满。
     */
    addSnapshot(state, name = '') {
      if (snapshots.length >= MAX_SNAPSHOTS) return null;
      const sequence = (snapshotSeq += 1);
      const item = {
        id: `snap-${sequence}`,
        name: name || `快照 ${snapshots.length + 1}`,
        state,
        at: Date.now(),
      };
      snapshots.push(item);
      bytes += sizeOf(state);
      return item;
    },
    removeSnapshot(id) {
      const index = snapshots.findIndex((item) => item.id === id);
      if (index < 0) return false;
      const [removed] = snapshots.splice(index, 1);
      bytes = Math.max(0, bytes - sizeOf(removed.state));
      return true;
    },
    findSnapshot(id) {
      return snapshots.find((item) => item.id === id) || null;
    },
    /** 生成不重复的默认快照名（删除中间项后不会重复）。 */
    nextSnapshotName() {
      let max = 0;
      for (const item of snapshots) {
        const match = /^快照\s+(\d+)$/.exec(item.name);
        if (match) max = Math.max(max, Number(match[1]));
      }
      return `快照 ${max + 1}`;
    },
  };
}
