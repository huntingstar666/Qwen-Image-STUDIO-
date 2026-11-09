const state = {
  schema: null,
  health: null,
  projects: [],
  project: null,
  selectedId: "",
  pxPerSec: 36,
  task: null,
  peaks: null,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function selectedShot() {
  const project = state.project;
  if (!project) return null;
  return (project.shots || []).find((shot) => shot.id === state.selectedId) || null;
}

export function shotAt(ms) {
  const project = state.project;
  if (!project) return null;
  const shots = project.shots || [];
  return shots.find((shot) => ms >= shot.startMs && ms < shot.endMs) || shots[shots.length - 1] || null;
}
