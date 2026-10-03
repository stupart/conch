// The lagoon's API as the app sees it (MAC-APP-SPEC.md §4), recording every call for the harness (window.__calls).
const Q = new URLSearchParams(location.search);
const calls = (window.__calls = []);
const crew = new Map();
let visible = true;
let liveness = 'checking';
const zone = r => (r.needsResponse || r.status === 'needs' ? 'needs'
  : r.status !== 'working' && (r.reviews || []).some(v => v.viewedAt == null) ? 'ready'
  : r.status === 'working' ? 'working' : 'idle');

window.conchWorld = {
  version: 1,
  mode: Q.has('app') ? 'app' : 'live',
  readOnly: Q.has('readonly'),
  actions: [],
  update(snapshot) {
    if (typeof snapshot === 'string') snapshot = JSON.parse(snapshot);
    calls.push({ name: 'update', snapshot: JSON.parse(JSON.stringify(snapshot)) });
    crew.clear();
    for (const r of snapshot.rows || []) if (!(snapshot.dismissed || []).includes(r.id)) crew.set(r.id, r);
    const tally = { needs: 0, ready: 0, working: 0, idle: 0 };
    for (const r of crew.values()) tally[zone(r)]++;
    if (liveness !== 'alive') this.setLiveness('alive');
    return tally;
  },
  setLiveness(state, reason = '') { liveness = state; calls.push({ name: 'setLiveness', state, reason }); },
  get liveness() { return liveness; },
  setVisible(v) { visible = !!v; calls.push({ name: 'setVisible', visible }); },
  get visible() { return visible; },
  focus(sessionId) { calls.push({ name: 'focus', sessionId }); return crew.has(sessionId); },
  state() {
    return [...crew.values()].map(r => ({ id: r.id, label: r.label, zone: zone(r), species: 'stub', x: 0, z: 0, parent: r.parentSessionId || null }));
  },
};

// Read over the scheme, as the real page reads its sprites' manifest.
window.__hello = await (await fetch('data/hello.json')).json();
document.getElementById('status').textContent = 'ready';
// The app answers this with the latest snapshot and the daemon's liveness.
window.webkit?.messageHandlers?.conchWorld?.postMessage({ v: 1, name: 'ready' });
