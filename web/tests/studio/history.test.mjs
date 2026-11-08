import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../../src/components/studio/history.js';

test('历史快照：命名、查找与删除', () => {
  const history = createHistory();
  const state = history.push({ version: 1, bytes: 10 });
  const snapshot = history.addSnapshot(state, '基线');
  assert.match(snapshot.id, /^snap-/);
  assert.equal(snapshot.name, '基线');
  assert.equal(snapshot.state, state);
  assert.equal(history.findSnapshot(snapshot.id), snapshot);

  assert.equal(history.removeSnapshot(snapshot.id), true);
  assert.equal(history.findSnapshot(snapshot.id), null);
  assert.equal(history.removeSnapshot(snapshot.id), false);
});

test('历史快照：不占撤销步数，默认名递增', () => {
  const history = createHistory();
  const first = history.push({ version: 1, bytes: 10 });
  assert.equal(history.canUndo, false);
  const a = history.addSnapshot(first);
  assert.equal(a.name, '快照 1');
  assert.equal(history.canUndo, false);

  history.push({ version: 2, bytes: 10 });
  const b = history.addSnapshot({ version: 2, bytes: 10 });
  assert.equal(b.name, '快照 2');
  assert.equal(history.snapshots.length, 2);
  assert.notEqual(a.id, b.id);
});

test('历史快照：默认名在删除中间项后不重复', () => {
  const history = createHistory();
  const state = history.push({ version: 1, bytes: 10 });
  const first = history.addSnapshot(state, '快照 1');
  const second = history.addSnapshot(state, '快照 2');
  assert.equal(history.nextSnapshotName(), '快照 3');
  history.removeSnapshot(first.id);
  assert.equal(history.nextSnapshotName(), '快照 3');
  history.removeSnapshot(second.id);
  assert.equal(history.nextSnapshotName(), '快照 1');
});

test('历史快照：历史清空/撤销后仍保留快照引用', () => {
  const history = createHistory();
  const base = history.push({ version: 1, bytes: 10 });
  const snapshot = history.addSnapshot(base, '初始');
  history.push({ version: 2, bytes: 10 });
  history.undo();
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.findSnapshot(snapshot.id).state.version, 1);
});
