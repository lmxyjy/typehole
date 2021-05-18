import { EventEmitter } from "events";
import * as vscode from "vscode";
import { getId } from "./hole";
import { log } from "./logger";
import { findTypeholes, getAST } from "./parse/module";

export const events = new EventEmitter();

type TypeHole = { id: string; fileName: string };

let state = {
  nextUniqueId: 0,
  warnings: {} as Record<string, vscode.Range[]>,
  holes: [] as TypeHole[],
  samples: {} as Record<string, any[]>,
};

export type State = typeof state;

export function getNextAvailableId() {
  return state.nextUniqueId;
}

export function clearWarnings(fileName: string) {
  const state = getState();
  setState({ ...state, warnings: { ...state.warnings, [fileName]: [] } });
}

export function getWarnings(fileName: string) {
  const state = getState();
  return state.warnings[fileName] || [];
}

export function addWarning(fileName: string, range: vscode.Range) {
  const state = getState();
  const alreadyExists = getWarnings(fileName).some(
    (w) => w.start.isEqual(range.start) && w.end.isEqual(range.end)
  );
  if (alreadyExists) {
    return;
  }

  setState({
    ...state,
    warnings: {
      ...state.warnings,
      [fileName]: getWarnings(fileName).concat(range),
    },
  });
}

export function getSamples(id: string) {
  return getState().samples[id] || [];
}

export function addSample(id: string, sample: any) {
  const currentState = getState();
  const existing = getSamples(id);

  const newSamples = [sample].concat(existing);

  setState({
    ...currentState,
    samples: {
      ...currentState.samples,
      [id]: newSamples,
    },
  });
  return newSamples;
}

function clearSamples(id: string, currentState: typeof state) {
  return {
    ...currentState,
    samples: {
      ...currentState.samples,
      [id]: [],
    },
  };
}

function createTypehole(id: string, fileName: string) {
  const hole = { id, fileName };
  const currentState = getState();
  setState({
    ...currentState,
    nextUniqueId: currentState.nextUniqueId + 1,
    holes: [...currentState.holes, hole],
  });
}

function removeTypehole(id: string) {
  const currentState = getState();

  setState(
    clearSamples(id, {
      ...currentState,
      holes: currentState.holes.filter((h) => h.id !== id),
    })
  );
}

function setState(newState: typeof state): void {
  state = newState;
  events.emit("change", newState);
}

export function getState() {
  return state;
}

export function onFileDeleted(fileName: string) {
  getState()
    .holes.filter((hole) => hole.fileName === fileName)
    .forEach((h) => removeTypehole(h.id));
}

export function onFileChanged(fileName: string, content: string) {
  const knownHolesInThisFile = state.holes.filter(
    (hole) => hole.fileName === fileName
  );
  const knownIds = knownHolesInThisFile.map(({ id }) => id);

  const ast = getAST(content);
  const holesInDocument = findTypeholes(ast).map(getId);

  // Update state to reflect current holes in the document
  holesInDocument.forEach((holeId) => {
    const newHoleWasAdded = !knownIds.includes(holeId);
    if (newHoleWasAdded) {
      log("Found a new typehole from", fileName);
      createTypehole(holeId, fileName);
    }
  });
  knownIds.forEach((holeId) => {
    const holeHasBeenRemoved = !holesInDocument.includes(holeId);
    if (holeHasBeenRemoved) {
      removeTypehole(holeId);
    }
  });
}

export function getHole(id: string) {
  return state.holes.find((hole) => hole.id === id);
}
