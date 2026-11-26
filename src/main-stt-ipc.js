const fs = require('fs');
const path = require('path');
const secureCreds = require('./secure-credentials');
const { writeFileAtomic } = require('./atomic');
const { redactSecrets } = require('./redact');

const STT_CREDENTIAL_REF = 'cred:stt_api_key';
const STT_CFG_FILE = 'stt-config.json';

function getUrlOrigin(raw) {
  try { return typeof raw === 'string' && raw.trim() ? new URL(raw.trim()).origin : ''; } catch { return ''; }
}

/**
 * STT 语音识别配置、凭据与音频转写 IPC 注册器。
 * 全部通道经注入的 ipcGuard 注册，绝不绕过守卫直接调 ipcMain。
 */
function registerSttIpc(ipcGuard, ctx) {
  const { app, getSS } = ctx;

  function readSttConfig() {
    const empty = { endpoint: '', model: '', lang: '' };
    try {
      const p = path.join(app.getPath('userData'), STT_CFG_FILE);
      if (!fs.existsSync(p)) return empty;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        lang: typeof raw.lang === 'string' ? raw.lang : ''
      };
    } catch (e) {
      return empty;
    }
  }

  function writeSttConfig(patch) {
    const dir = app.getPath('userData');
    const cur = readSttConfig();
    const next = {
      endpoint: typeof patch.endpoint === 'string' ? patch.endpoint.trim() : cur.endpoint,
      model: typeof patch.model === 'string' ? patch.model.trim() : cur.model,
      lang: typeof patch.lang === 'string' ? patch.lang.trim() : cur.lang
    };
    try {
      writeFileAtomic(path.join(dir, STT_CFG_FILE), JSON.stringify(next, null, 2) + '\n');
      return next;
    } catch (e) {
      return null;
    }
  }

  function readSttSecret() {
    try {
      return secureCreds.getCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS });
    } catch (e) {
      return null;
    }
  }

  ipcGuard.handle('stt:get-config', () => {
    const c = readSttConfig();
    let desc = { present: false, encrypted: false };
    try {
      desc = secureCreds.describeCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS });
    } catch (e) { /* 读不到就是没有，不抛 */ }
    return {
      ok: true,
      endpoint: c.endpoint,
      model: c.model,
      lang: c.lang,
      hasKey: desc.present === true,
      encrypted: desc.encrypted === true
    };
  });

  ipcGuard.handle('stt:set-config', (e, opts = {}) => {
    const patch = {
      endpoint: typeof opts.endpoint === 'string' ? opts.endpoint : '',
      model: typeof opts.model === 'string' ? opts.model : '',
      lang: typeof opts.lang === 'string' ? opts.lang : ''
    };
    if (patch.endpoint.trim()) {
      const v = require('./stt-transport').validateConfig({
        endpoint: patch.endpoint, apiKey: 'v', model: patch.model || 'v', lang: patch.lang
      });
      if (!v.ok) return { ok: false, errorType: v.errorType, error: v.detail || v.errorType };
    }
    const prevOrigin = getUrlOrigin(readSttConfig().endpoint);
    const saved = writeSttConfig(patch);
    if (!saved) return { ok: false, errorType: 'config_write_failed' };

    const hasNewCred = typeof opts.credential === 'string' && opts.credential.trim().length > 0;
    if (prevOrigin && prevOrigin !== getUrlOrigin(saved.endpoint) && !hasNewCred) {
      try { secureCreds.deleteCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS }); } catch {}
    }

    let encrypted = null;
    if (hasNewCred) {
      const w = secureCreds.setCredential(STT_CREDENTIAL_REF, opts.credential.trim(), {
        dir: app.getPath('userData'), getSS
      });
      if (!w.ok) return { ok: false, error: 'CREDENTIAL_WRITE_FAILED: ' + (w.error || '') };
      encrypted = w.encrypted === true;
    }
    return { ok: true, config: saved, encrypted };
  });

  ipcGuard.handle('stt:clear-key', () => {
    try {
      const r = secureCreds.deleteCredential(STT_CREDENTIAL_REF, { dir: app.getPath('userData'), getSS });
      return { ok: true, deleted: r && r.deleted !== false };
    } catch (e) {
      return { ok: false, error: 'CREDENTIAL_DELETE_FAILED' };
    }
  });

  ipcGuard.handle('stt:transcribe', async (e, opts = {}) => {
    if (!opts || typeof opts !== 'object') return { ok: false, errorType: 'invalid_input' };
    const c = readSttConfig();
    const secret = readSttSecret();
    if (!secret) return { ok: false, errorType: 'not_configured' };

    const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;
    const audio = opts && opts.audio;
    const rawLen = audio instanceof ArrayBuffer
      ? audio.byteLength
      : (audio && typeof audio.byteLength === 'number'
        ? audio.byteLength
        : (audio && typeof audio.length === 'number' ? audio.length : 0));
    if (rawLen > MAX_STT_AUDIO_BYTES) return { ok: false, errorType: 'audio_too_large' };
    let buf = null;
    try {
      if (audio instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(audio));
      else if (audio && typeof audio.length === 'number') buf = Buffer.from(audio);
    } catch (err) {
      buf = null;
    }
    if (!buf || !buf.length) return { ok: false, errorType: 'no_audio' };
    if (buf.length > MAX_STT_AUDIO_BYTES) return { ok: false, errorType: 'audio_too_large' };

    let sttMod;
    try {
      sttMod = require('./stt-transport');
    } catch (err) {
      return { ok: false, errorType: 'transport_unavailable' };
    }

    const r = await sttMod.transcribe({
      audio: buf,
      mimeType: typeof opts.mimeType === 'string' ? opts.mimeType : 'audio/webm',
      cfg: {
        endpoint: c.endpoint,
        apiKey: secret,
        model: c.model,
        lang: typeof opts.lang === 'string' && opts.lang ? opts.lang : c.lang
      }
    });

    if (r.ok) {
      return { ok: true, text: r.text, elapsedMs: r.elapsedMs };
    }
    return { ok: false, errorType: r.errorType };
  });

  ipcGuard.on('stt-audit', (e, payload = {}) => {
    try {
      const dir = app.getPath('userData');
      const line = {
        at: new Date().toISOString(),
        stage: typeof payload.stage === 'string' ? payload.stage.slice(0, 32) : null,
        elapsedMs: Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : null,
        chunksCount: Number.isFinite(payload.chunksCount) ? payload.chunksCount : null,
        bytes: Number.isFinite(payload.bytes) ? payload.bytes : null,
        mime: typeof payload.mime === 'string' ? payload.mime.slice(0, 60) : null,
        textLen: Number.isFinite(payload.textLen) ? payload.textLen : null,
        errorType: typeof payload.errorType === 'string' ? payload.errorType.slice(0, 40) : null,
        error: typeof payload.error === 'string'
          ? String(redactSecrets(payload.error)).slice(0, 120)
          : null
      };
      const sttAuditFile = path.join(dir, 'stt-audit.jsonl');
      try {
        const st = fs.statSync(sttAuditFile);
        if (st && st.size >= 1024 * 1024) {
          fs.renameSync(sttAuditFile, sttAuditFile + '.1');
        }
      } catch {}
      fs.appendFileSync(sttAuditFile, JSON.stringify(line) + '\n', 'utf8');
    } catch (err) {
      // 审计写失败绝不外抛
    }
  });
}

module.exports = { registerSttIpc, STT_CREDENTIAL_REF, STT_CFG_FILE, getUrlOrigin };
