const connectionsMod = require('./connections');
const secureCreds = require('./secure-credentials');
const { activateConnection } = require('./connection-switch');
const { runConnectionTest } = require('./connection-test');
const { probeLocalEndpoint } = require('./local-probe');
const { Brain } = require('./brain');

/**
 * Connection 管理控制器与 IPC 注册器（0.9.8 Z3）。
 * 凭据只进不出，全部通道经注入的 ipcGuard（SEC-01）注册。
 */
function createConnectionsController(ctx) {
  const {
    app, getSS, getCfg, setCfg, getBrain, setBrain,
    persistCfg, bindBrainDeps, clearAuthFailureBackoff,
    scheduleProactiveCheck, COOLDOWN_MS,
  } = ctx;

  function connectionDto(c) {
    const cfg = getCfg();
    const desc = secureCreds.describeCredential(c.credentialRef, {
      dir: app.getPath('userData'),
      getSS,
      fallbackSecret: c.credentialOwnership === 'legacy-mapped' ? (cfg && cfg.apiKey) || '' : ''
    });
    return {
      connectionId: c.connectionId,
      displayName: c.displayName,
      providerId: c.providerId,
      protocol: c.protocol,
      baseURL: c.baseURL,
      models: c.models,
      activeModel: c.activeModel,
      capabilitySnapshot: c.capabilitySnapshot,
      testState: c.testState,
      hasCredential: desc.present,
      keyEncrypted: desc.encrypted
    };
  }

  function ensureConnectionStore() {
    try {
      const cfg = getCfg();
      const dir = app.getPath('userData');
      if (connectionsMod.loadStore(dir).status === 'absent') {
        connectionsMod.migrateLegacyConfig(dir, cfg || {});
      }
    } catch { /* fail-closed：迁移失败不影响旧配置路径 */ }
  }

  function registerConnectionsIpc(ipcGuard) {
    ipcGuard.handle('connections:list', () => {
      ensureConnectionStore();
      const st = connectionsMod.loadStore(app.getPath('userData'));
      if (!st.ok) return { ok: false, error: st.error };
      if (!st.store) return { ok: true, activeConnectionId: null, items: [] };
      return {
        ok: true,
        activeConnectionId: st.store.activeConnectionId,
        items: st.store.connections.map(connectionDto)
      };
    });

    const safeObj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

    ipcGuard.handle('connections:get', (e, opts) => {
      const safeOpts = safeObj(opts);
      ensureConnectionStore();
      const st = connectionsMod.loadStore(app.getPath('userData'));
      if (!st.ok) return { ok: false, error: st.error };
      const c = st.store && st.store.connections.find((x) => x.connectionId === safeOpts.connectionId);
      return c ? { ok: true, connection: connectionDto(c) } : { ok: false, error: 'CONNECTION_NOT_FOUND' };
    });

    ipcGuard.handle('connections:create', (e, opts = {}) => {
      const safeOpts = safeObj(opts);
      ensureConnectionStore();
      const r = connectionsMod.createConnection(app.getPath('userData'), {
        displayName: safeOpts.displayName,
        providerId: safeOpts.providerId,
        protocol: safeOpts.protocol,
        baseURL: safeOpts.baseURL,
        model: safeOpts.model
      });
      if (!r.ok) return r;
      if (typeof safeOpts.credential === 'string' && safeOpts.credential) {
        const w = secureCreds.setCredential(r.connection.credentialRef, safeOpts.credential, { dir: app.getPath('userData'), getSS });
        if (!w.ok) {
          connectionsMod.deleteConnection(app.getPath('userData'), r.connection.connectionId, { deleteCredential: true, getSS });
          return { ok: false, error: 'CREDENTIAL_WRITE_FAILED: ' + (w.error || '') };
        }
      }
      return { ok: true, connectionId: r.connection.connectionId };
    });

    ipcGuard.handle('connections:update', (e, opts = {}) => {
      const safeOpts = safeObj(opts);
      const connectionId = safeOpts.connectionId;
      const patch = safeObj(safeOpts.patch);
      const credential = safeOpts.credential;
      const hasNewCred = typeof credential === 'string' && credential.trim().length > 0;
      const r = connectionsMod.updateConnection(app.getPath('userData'), connectionId, patch, {
        allowOriginChange: hasNewCred
      });
      if (!r.ok) return r;
      if (hasNewCred) {
        const w = secureCreds.setCredential(r.connection.credentialRef, credential.trim(), { dir: app.getPath('userData'), getSS });
        if (!w.ok) return { ok: false, error: 'CREDENTIAL_WRITE_FAILED: ' + (w.error || '') };
      }
      return { ok: true };
    });

    ipcGuard.handle('connections:delete', (e, opts = {}) => {
      const safeOpts = safeObj(opts);
      const r = connectionsMod.deleteConnection(app.getPath('userData'), safeOpts.connectionId, {
        deleteCredential: safeOpts.deleteCredential !== false,
        getSS
      });
      if (!r.ok) return r;
      return { ok: true, credentialDeleted: r.credentialDeleted, credentialNote: r.credentialNote };
    });

    ipcGuard.handle('connections:test', async (e, opts = {}) => {
      const safeOpts = safeObj(opts);
      const cfg = getCfg();
      const dir = app.getPath('userData');
      const r = await runConnectionTest(dir, safeOpts.connectionId, { getSS, fallbackSecret: (cfg && cfg.apiKey) || '' });
      if (r.ok) {
        try {
          connectionsMod.updateConnection(dir, safeOpts.connectionId, {
            testState: { status: r.status, phase: r.phase, reason: r.reason || null, lastTestedAt: Date.now() }
          });
        } catch { /* 快照持久化失败不影响测试结果返回 */ }
      }
      return r;
    });

    ipcGuard.handle('connections:activate', (e, opts = {}) => {
      const safeOpts = safeObj(opts);
      const dir = app.getPath('userData');
      const st = connectionsMod.loadStore(dir);
      if (!st.ok) return { ok: false, swapped: false, error: st.error };
      if (!st.store) return { ok: false, swapped: false, error: 'STORE_ABSENT' };
      const targetId = safeOpts.connectionId;
      const brain = getBrain();
      const cfg = getCfg();
      if (st.store.activeConnectionId === targetId && brain) {
        return { ok: true, activeConnectionId: targetId, swapped: false };
      }
      const r = activateConnection({
        dir,
        targetConnectionId: targetId,
        oldBrain: brain,
        oldCfg: cfg,
        persistFlat: (c) => { persistCfg(c); },
        createCandidate: (c) => new Brain(app.getPath('userData'), c, { getSS }),
        bindCandidate: bindBrainDeps,
        getSS,
        fallbackSecret: (cfg && cfg.apiKey) || ''
      });
      if (!r.ok) {
        return { ok: false, swapped: false, activeConnectionId: r.activeConnectionId, error: r.error };
      }
      setCfg(r.cfg);
      setBrain(r.brain);
      clearAuthFailureBackoff();
      scheduleProactiveCheck(COOLDOWN_MS);
      return { ok: true, activeConnectionId: r.activeConnectionId, swapped: true };
    });

    ipcGuard.handle('connections:probe-local', async (e, opts = {}) => {
      const safeOpts = safeObj(opts);
      const baseURL = typeof safeOpts.baseURL === 'string' ? safeOpts.baseURL.trim() : '';
      const expectedModel = typeof safeOpts.model === 'string' ? safeOpts.model.trim() : '';
      if (!baseURL) {
        return {
          ok: false,
          reachable: false,
          serverKind: 'unknown',
          models: [],
          modelMatched: null,
          reason: 'NON_LOCAL_HOST_REJECTED'
        };
      }
      return await probeLocalEndpoint(baseURL, { expectedModel });
    });
  }

  return { connectionDto, ensureConnectionStore, registerConnectionsIpc };
}

module.exports = { createConnectionsController };
