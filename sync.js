// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two placeholders with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://yfoylrlhvfexeiyuwvlb.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlmb3lscmxodmZleGVpeXV3dmxiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNDY4NzQsImV4cCI6MjA5NTgyMjg3NH0.h9LY_x4iJNPjMdJcE6ZXXxx06rX5Nj67KpUAyrMtmRc';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);

    // -------- Local "touched" timestamp --------
    // Guards against the classic race: an initial fetch returns stale remote
    // data and stomps on a local edit made moments earlier (before the local
    // push completed). We persist the time of the last genuine local edit and
    // only ever let remote data overwrite local data when the remote row is
    // actually newer than that — never the other way around.
    const META_KEY = '__sync_meta_' + appKey;
    let localTouchedAt = 0;
    try {
      const m = JSON.parse(localStorage.getItem(META_KEY));
      if (m && typeof m.touchedAt === 'number') localTouchedAt = m.touchedAt;
    } catch (e) {}
    function setTouchedAt(t) {
      localTouchedAt = t;
      try { origSet(META_KEY, JSON.stringify({ touchedAt: t })); } catch (e) {}
    }

    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) { setTouchedAt(Date.now()); schedulePush(); } } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) { setTouchedAt(Date.now()); schedulePush(); } } catch (e) {}
    };
    function applyRemote(remote, remoteTime) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      // Remote is now the source of truth as of remoteTime — record that so a
      // reload doesn't think the (just-applied) local copy is "newer" than it.
      if (typeof remoteTime === 'number' && remoteTime > localTouchedAt) setTouchedAt(remoteTime);
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }
    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) lastSyncedJson = json;
      } catch (e) {}
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data, updated_at').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          const remoteTime = data.updated_at ? new Date(data.updated_at).getTime() : 0;
          if (remoteTime > localTouchedAt) {
            lastSyncedJson = JSON.stringify(data.data);
            applyRemote(data.data, remoteTime);
          } else if (Object.keys(collect()).length > 0) {
            // Local was edited more recently than the remote row — local wins;
            // push it up so the remote (and other devices) catch up.
            schedulePush();
          }
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const remoteTime = payload.new.updated_at ? new Date(payload.new.updated_at).getTime() : 0;
          if (remoteTime <= localTouchedAt) return; // stale or our own echo — ignore
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data, remoteTime);
        })
        .subscribe();
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();
