export function createMonitorState(overrides = {}) {
  return {
    sessionId: null, threadId: null, cwd: null,
    boundIdentity: null, armedIdentity: null,
    cursor: null, pendingWake: false, turnActive: false, lastError: null,
    ...overrides,
  };
}

const result = (state, effects = []) => ({ state, effects });

export function registerSession(state, { sessionId, threadId, cwd }) {
  return result({ ...state, sessionId, threadId, cwd });
}

export function bindingChanged(state, identity) {
  const effects = [];
  if (state.armedIdentity && state.armedIdentity !== identity) effects.push({ type: 'unsubscribe', identity: state.armedIdentity });
  return result({ ...state, boundIdentity: identity, armedIdentity: state.armedIdentity === identity ? identity : null, cursor: state.armedIdentity === identity ? state.cursor : null, pendingWake: false }, effects);
}

export function arm(state, identity) {
  if (!identity) throw new Error('cannot arm an empty identity');
  if (state.boundIdentity && state.boundIdentity !== identity) throw new Error(`cannot arm ${identity}; current binding is ${state.boundIdentity}`);
  if (state.armedIdentity === identity) return result(state);
  // The arm tool itself is an explicit, identity-named consent boundary. Claiming an
  // otherwise-unset binding here keeps live wake functional before plugin hooks have
  // been reviewed; trusted PostToolUse hooks still synchronize later identity switches.
  return result({ ...state, boundIdentity: identity, armedIdentity: identity, cursor: null, pendingWake: false, lastError: null }, [{ type: 'subscribe', identity }]);
}

export function disarm(state) {
  const effects = state.armedIdentity ? [{ type: 'unsubscribe', identity: state.armedIdentity }] : [];
  return result({ ...state, armedIdentity: null, cursor: null, pendingWake: false }, effects);
}

export function notificationArrived(state, cursor) {
  if (!state.armedIdentity) return result({ ...state, cursor });
  if (state.pendingWake) return result({ ...state, cursor });
  if (state.turnActive) return result({ ...state, cursor, pendingWake: true });
  return result({ ...state, cursor, pendingWake: true }, [{ type: 'startWakeTurn' }]);
}

export function turnStarted(state) {
  return result({ ...state, turnActive: true, pendingWake: false });
}

export function turnCompleted(state) {
  if (state.pendingWake && state.armedIdentity) return result({ ...state, turnActive: false }, [{ type: 'startWakeTurn' }]);
  return result({ ...state, turnActive: false, pendingWake: false });
}

export function withError(state, error) {
  return result({ ...state, lastError: String(error) });
}
