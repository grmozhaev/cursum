/* Cloud synchronization is opt-in: local data is never uploaded until chosen. */
const cloud = {
  client: null,
  user: null,
  revision: 0,
  dirty: false,
  baseline: null,
  ready: false,
  saving: false,
  applying: false,
  timer: null,
  remote: null,
  connecting: false,
  connectionFailed: false,
  get metaKey() { return `cursum-v2-sync-${this.user.id}`; },
  status(message, retry = false) {
    document.getElementById('cloud-status').textContent = message;
    document.getElementById('cloud-retry').hidden = !retry;
  },
  choices(show) { document.getElementById('cloud-choices').hidden = !show; },
  metadata() {
    localStorage.setItem(this.metaKey, JSON.stringify({ revision: this.revision, dirty: this.dirty, baseline: this.baseline }));
  },
  async start() {
    const oldSave = app.saveState.bind(app);
    app.saveState = () => {
      const previous = localStorage.getItem('finRadarDataV2');
      const saved = oldSave();
      if (saved && this.user && this.ready && !this.applying && localStorage.getItem('finRadarDataV2') !== previous) {
        this.dirty = true;
        this.metadata();
        this.schedule();
      }
      return saved;
    };
    if (!CURSUM_CONFIG.url || !CURSUM_CONFIG.publishableKey || !window.supabase) {
      this.status('Cloud storage is not configured yet. Your data remains in this browser.');
      return;
    }
    this.client = window.supabase.createClient(CURSUM_CONFIG.url, CURSUM_CONFIG.publishableKey, {
      auth: { storageKey: 'cursum-v2-auth' }
    });
    const { data, error } = await this.client.auth.getSession();
    if (error) { this.status('Could not restore your session: ' + error.message); return; }
    if (data.session) await this.connected(data.session.user);
    else this.status('Sign in to synchronize your data.');
    window.addEventListener('online', () => this.refresh());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
    setInterval(() => { if (this.user && (this.ready || this.connectionFailed)) this.refresh(); }, 15000);
  },
  async signIn(event) {
    event.preventDefault();
    if (!this.client) { this.status('Cloud storage is not configured yet.'); return; }
    const email = document.getElementById('cloud-email').value.trim();
    const password = document.getElementById('cloud-password').value;
    this.status('Signing in…');
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    document.getElementById('cloud-password').value = '';
    if (error) { this.status('Sign-in failed: ' + error.message); return; }
    await this.connected(data.user);
  },
  async connected(user) {
    if (this.connecting) return;
    this.connecting = true;
    this.connectionFailed = false;
    this.user = user;
    this.ready = false;
    document.getElementById('cloud-form').hidden = true;
    document.getElementById('cloud-signout').hidden = false;
    document.getElementById('cloud-account').open = false;
    document.getElementById('cloud-account').hidden = true;
    document.getElementById('private-dashboard').hidden = false;
    document.getElementById('private-tools').hidden = false;
    this.status('Checking cloud data…');
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.metaKey)); } catch (_) {}
    const result = await this.read();
    this.connecting = false;
    if (!this.user || this.user.id !== user.id) return;
    if (result.error) {
      this.connectionFailed = true;
      this.status('Could not check cloud data. Your browser copy is unchanged. Retrying automatically.', true);
      return;
    }
    this.remote = result.row;
    if (localStorage.getItem('cursum-v2-cleared-on-signout') === user.id && this.remote) {
      this.applyRemote(this.remote);
      return;
    }
    if (saved && localStorage.getItem('cursum-v2-local-owner') === user.id && Number.isSafeInteger(saved.revision) && saved.revision > 0) {
      this.revision = saved.revision;
      this.baseline = saved.baseline;
      this.dirty = saved.dirty === true || localStorage.getItem('finRadarDataV2') !== this.baseline;
      this.ready = true;
      if (!this.remote || this.remote.revision !== this.revision) {
        if (this.dirty) { this.conflict(); return; }
        if (this.remote) { this.applyRemote(this.remote); return; }
        this.conflict(); return;
      }
      if (this.dirty) this.schedule();
      else this.status('Signed in. V2 data is synchronized.');
      return;
    }
    this.choices(true);
    this.status(this.remote
      ? 'Cloud data and this browser copy may differ. Choose which to use; back up first.'
      : 'No v2 cloud data exists yet. Choose “Upload this browser’s v2 data” to start syncing.');
    document.getElementById('cloud-use-remote').disabled = !this.remote;
  },
  async read() {
    try {
      const { data, error } = await this.client.from('cursum_v2_data').select('data,revision').maybeSingle();
      return { row: data, error };
    } catch (error) {
      return { row: null, error };
    }
  },
  schedule() {
    clearTimeout(this.timer);
    this.status('Changes saved in this browser; syncing…');
    this.timer = setTimeout(() => this.flush(), 1000);
  },
  async flush() {
    if (!this.ready || !this.user || !this.dirty || this.saving) return;
    this.saving = true;
    const snapshot = localStorage.getItem('finRadarDataV2');
    let parsed;
    try { parsed = JSON.parse(snapshot); } catch (_) { this.saving = false; this.status('Cannot sync invalid browser data.'); return; }
    let result;
    try {
      result = await this.client.rpc('save_cursum_v2_data', { p_data: parsed, p_expected_revision: this.revision });
    } catch (error) {
      result = { data: null, error };
    }
    this.saving = false;
    const { data, error } = result;
    if (error) { this.status('Sync failed. Your changes remain in this browser and will be retried.', true); return; }
    if (data === null) { this.conflict(); return; }
    this.revision = data;
    localStorage.removeItem('cursum-v2-cleared-on-signout');
    this.baseline = snapshot;
    localStorage.setItem('cursum-v2-local-owner', this.user.id);
    this.dirty = localStorage.getItem('finRadarDataV2') !== snapshot;
    this.metadata();
    if (this.dirty) this.schedule(); else this.status('Signed in. V2 data is synchronized.');
  },
  conflict() {
    this.dirty = true;
    this.metadata();
    this.ready = false;
    this.choices(true);
    document.getElementById('cloud-use-remote').disabled = false;
    this.status('Data changed on another device. Both copies are preserved. Back up this browser copy, then choose which version to keep.');
  },
  async retry() {
    if (!this.user) return;
    if (this.connectionFailed) await this.connected(this.user);
    else if (this.ready) await this.refresh();
  },
  async refresh() {
    if (!this.user || this.saving || this.connecting) return;
    if (this.connectionFailed) { await this.connected(this.user); return; }
    if (!this.ready) return;
    const user = this.user;
    const revision = this.revision;
    const { row, error } = await this.read();
    // A save or sign-out may have completed while this read was in flight.
    if (this.user !== user || !this.ready || this.saving || this.revision !== revision) return;
    if (error) { this.status('Cloud unavailable. Your browser copy is preserved; retrying.', true); return; }
    if (!row || row.revision !== this.revision) {
      if (this.dirty || !row) { this.conflict(); return; }
      this.applyRemote(row);
    } else if (this.dirty) this.schedule();
    else this.status('Signed in. V2 data is synchronized.');
  },
  applyRemote(row) {
    if (!row || !row.data || !Array.isArray(row.data.assets) || !Array.isArray(row.data.income) || !Array.isArray(row.data.history)) {
      this.status('Cloud data has an unexpected format. The browser copy was not changed.'); return;
    }
    try { app.validateBackup({ format: 'cursum-v2-backup', version: 1, data: row.data }); }
    catch (_) { this.status('Cloud data has an unexpected format. The browser copy was not changed.'); return; }
    localStorage.removeItem('cursum-v2-cleared-on-signout');
    this.applying = true;
    // Preserve currencies even if the exchange-rate service is temporarily unavailable.
    const codes = [row.data.target, row.data.expense.currency, ...row.data.assets.map(item => item.currency), ...row.data.income.map(item => item.currency)];
    codes.filter(Boolean).forEach(code => { if (!app.currencies.includes(code)) app.currencies.push(code); });
    app.data = structuredClone(row.data);
    localStorage.setItem('finRadarDataV2', JSON.stringify(app.data));
    document.getElementById('target-currency').innerHTML = '';
    app.renderInputs();
    app.update();
    app.updateChart();
    this.applying = false;
    this.revision = row.revision;
    this.baseline = localStorage.getItem('finRadarDataV2');
    localStorage.setItem('cursum-v2-local-owner', this.user.id);
    this.dirty = false;
    this.ready = true;
    this.metadata();
    this.choices(false);
    this.status('Signed in. V2 data is synchronized.');
  },
  async useRemote() {
    if (!confirm('Replace this browser’s v2 data with the v2 cloud copy? Back up this browser copy first if needed.')) return;
    const snapshot = localStorage.getItem('finRadarDataV2');
    const user = this.user;
    const { row, error } = await this.read();
    if (this.user !== user || localStorage.getItem('finRadarDataV2') !== snapshot) { this.status('The browser copy changed while loading. Please choose again.'); return; }
    if (error || !row) { this.status('Could not load cloud data. Your browser copy is unchanged.'); return; }
    this.applyRemote(row);
  },
  async uploadLocal() {
    if (!confirm('Upload this browser’s v2 data? If v2 cloud data exists, it will be replaced. Back up both copies first. Your current version is unaffected.')) return;
    const { row, error } = await this.read();
    if (error) { this.status('Could not check cloud data. Your browser copy is unchanged.'); return; }
    this.revision = row ? row.revision : 0;
    this.dirty = true;
    this.ready = true;
    this.metadata();
    this.choices(false);
    await this.flush();
  },
  async signOut() {
    if (this.saving || this.connecting) { this.status('Please wait for the current sync to finish before signing out.'); return; }
    if (!this.ready || this.dirty || !this.baseline || localStorage.getItem('finRadarDataV2') !== this.baseline) {
      this.status('Your browser copy is not synchronized. Resolve the sync issue and back up your data before signing out.', true);
      return;
    }
    clearTimeout(this.timer);
    const dashboard = document.getElementById('private-dashboard');
    const tools = document.getElementById('private-tools');
    dashboard.inert = true;
    tools.inert = true;
    const userId = this.user.id;
    let error;
    try { ({ error } = await this.client.auth.signOut()); }
    catch (failure) { error = failure; }
    if (error) {
      dashboard.inert = false;
      tools.inert = false;
      this.status('Could not sign out: ' + error.message);
      return;
    }
    dashboard.hidden = true;
    tools.hidden = true;
    this.user = null; this.ready = false; this.dirty = false; this.connectionFailed = false;
    this.choices(false);
    document.getElementById('cloud-form').hidden = false;
    document.getElementById('cloud-account').hidden = false;
    document.getElementById('cloud-signout').hidden = true;
    try {
      if (localStorage.getItem('finRadarDataV2') !== this.baseline) {
        this.status('Signed out, but data changed during sign-out and remains in this browser to prevent data loss. Sign in to synchronize it.');
        return;
      }
      localStorage.removeItem('finRadarDataV2');
      localStorage.removeItem('cursum-v2-local-owner');
      localStorage.removeItem(`cursum-v2-sync-${userId}`);
      localStorage.setItem('cursum-v2-cleared-on-signout', userId);
      location.reload();
    } catch (_) {
      this.status('Signed out, but this browser could not clear its local data. Clear this site’s browser storage to remove it.');
    }
  }
};
