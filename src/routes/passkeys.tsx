import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { freshlyConfirmed, requireUser, verifyPassword } from '../lib/auth';
import { checkCode, notify, sendCode } from '../lib/messaging';
import { audit } from '../lib/audit';
import { PortalLayout, PublicLayout, Eyebrow, Flash } from '../views/layout';
import {
  authenticationOptions,
  finishAuthentication,
  finishRegistration,
  hasPasskey,
  newRecoveryCodes,
  passkeysOf,
  passkeysRequired,
  recoveryCodesLeft,
  registrationOptions,
  useRecoveryCode,
  grantTicket,
  hasTicket,
  STUDENT_PASSKEY_MAX,
} from '../lib/passkeys';

/**
 * Staff passkeys: set up (mandatory for owner, admins and faculty), sign in with one after the password,
 * confirm owner-only changes with one, and recover with a one-time code if the device is lost.
 */
export const passkeyRoutes = new Hono<AppEnv>();

const ip = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? null;
const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');
async function json(c: Context<AppEnv>): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Browser side: turns the server's JSON options into WebAuthn calls and the answers back into JSON. */
export const WEBAUTHN_JS = `
window.u100pk=(function(){
function b2u(b){var s='',a=new Uint8Array(b);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function u2b(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer}
function post(u,b){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json().then(function(j){j._status=r.status;return j})})}
function supported(){return !!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.create)}
function register(name){return post('/account/passkeys/options').then(function(o){if(o.error)throw new Error(o.error);
 o.challenge=u2b(o.challenge);o.user.id=u2b(o.user.id);(o.excludeCredentials||[]).forEach(function(c){c.id=u2b(c.id)});
 return navigator.credentials.create({publicKey:o})}).then(function(cr){var r=cr.response;
 return post('/account/passkeys/verify',{name:name,response:{id:cr.id,rawId:b2u(cr.rawId),type:cr.type,clientExtensionResults:cr.getClientExtensionResults?cr.getClientExtensionResults():{},authenticatorAttachment:cr.authenticatorAttachment||undefined,
  response:{clientDataJSON:b2u(r.clientDataJSON),attestationObject:b2u(r.attestationObject),transports:r.getTransports?r.getTransports():[]}}})})}
function authenticate(purpose){return post('/account/passkey/options',{purpose:purpose}).then(function(o){if(o.error)throw new Error(o.error);
 o.challenge=u2b(o.challenge);(o.allowCredentials||[]).forEach(function(c){c.id=u2b(c.id)});
 return navigator.credentials.get({publicKey:o})}).then(function(cr){var r=cr.response;
 return post('/account/passkey/verify',{purpose:purpose,response:{id:cr.id,rawId:b2u(cr.rawId),type:cr.type,clientExtensionResults:cr.getClientExtensionResults?cr.getClientExtensionResults():{},authenticatorAttachment:cr.authenticatorAttachment||undefined,
  response:{clientDataJSON:b2u(r.clientDataJSON),authenticatorData:b2u(r.authenticatorData),signature:b2u(r.signature),userHandle:r.userHandle?b2u(r.userHandle):undefined}}})})}
return {supported:supported,register:register,authenticate:authenticate};})();`;

export const PASSKEY_PAGE_JS = `
(function(){var out=document.getElementById('pk-msg');function say(t,bad){out.textContent=t;out.className='flash '+(bad?'flash-error':'flash-ok');out.hidden=false}
if(!u100pk.supported()){say('This browser can’t use passkeys. Please use an up-to-date Safari, Chrome, Edge or Firefox.',true);document.querySelectorAll('[data-pk]').forEach(function(b){b.disabled=true});return}
var add=document.querySelector('[data-pk="add"]');if(add)add.onclick=function(){var n=document.getElementById('pk-name');add.disabled=true;say('Follow your device’s prompt…');
 u100pk.register(n&&n.value||'').then(function(j){if(!j.ok){add.disabled=false;return say(j.error||'That didn’t work. Please try again.',true)}
  if(j.codes){var box=document.getElementById('pk-codes');box.hidden=false;box.querySelector('pre').textContent=j.codes.join('\\n');say('Passkey added. Save your recovery codes now: they are shown only once.');add.disabled=false;var d=document.getElementById('pk-done');if(d)d.hidden=false;return}
  location.href='/account/passkeys?ok=1'}).catch(function(e){add.disabled=false;say(e&&e.name==='NotAllowedError'?'The request was cancelled or timed out.':'That didn’t work: '+(e&&e.message||'unknown error'),true)})};
var go=document.querySelector('[data-pk="auth"]');if(go)go.onclick=function(){go.disabled=true;say('Follow your device’s prompt…');
 u100pk.authenticate(go.dataset.purpose).then(function(j){if(!j.ok){go.disabled=false;return say(j.error||'That passkey wasn’t accepted.',true)}location.href=go.dataset.next||'/dashboard'}).catch(function(e){go.disabled=false;say(e&&e.name==='NotAllowedError'?'The request was cancelled or timed out.':'That didn’t work: '+(e&&e.message||'unknown error'),true)})};
})();`;

// ---------- Manage (and the mandatory first setup for staff) ----------

/** Students may add up to 2 passkeys, from an approved device, after their password and email and phone codes. */
async function studentPasskeysPage(c: Context<AppEnv>) {
  const user = c.get('user')!;
  const db = c.env.DB;
  const s = c.get('session')!;
  const verified = !!(user.email_verified_at && user.phone_verified_at);
  const [keys, ticket, device] = await Promise.all([passkeysOf(db, user.id), hasTicket(db, s.tokenHash), activeDevice(db, user.id, s.deviceHash ?? null)]);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Passkeys" active="account" user={user}>
      <Eyebrow>My account</Eyebrow>
      <h1>Passkeys (optional)</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">A passkey lets you sign in with Face ID, Touch ID or your device’s screen lock instead of typing your password. Your password keeps working too. You can have up to {STUDENT_PASSKEY_MAX}, on your registered devices only.</p>
      <p id="pk-msg" class="flash" hidden role="status"></p>
      {!verified ? (
        <section class="card"><p style="margin:0">To add a passkey, first verify your email and phone number in <a href="/account">My account</a>.</p></section>
      ) : (
        <>
          <section class="card stack">
            <h2 style="margin:0">Your passkeys</h2>
            {keys.length === 0 ? <p class="muted" style="margin:0">None yet.</p> : keys.map((k) => (
              <div class="row" style="justify-content:space-between;align-items:center">
                <span>{k.name} <span class="muted small">· added {k.created_at.slice(0, 10)}</span></span>
                {ticket && <form method="post" action={`/account/passkeys/${k.id}/remove`}><button class="btn btn-ghost btn-sm" type="submit">Remove</button></form>}
              </div>
            ))}
          </section>
          {!ticket ? (
            <section class="card stack">
              <h2 style="margin:0">Confirm it’s you</h2>
              <p class="muted small" style="margin:0">Adding or removing a passkey needs your password and a code sent to your email and another to your phone.</p>
              <form method="post" action="/account/passkeys/send-codes"><button class="btn btn-outline btn-sm" type="submit">Send my codes</button></form>
              <form method="post" action="/account/passkeys/check" class="stack" style="gap:10px">
                <label class="field">Current password<input type="password" name="password" required autocomplete="current-password" /></label>
                <div class="grid">
                  <label class="field">Email code<input type="text" name="email_code" required inputmode="numeric" autocomplete="one-time-code" maxlength={6} /></label>
                  <label class="field">Phone code<input type="text" name="sms_code" required inputmode="numeric" autocomplete="one-time-code" maxlength={6} /></label>
                </div>
                <button class="btn btn-primary" type="submit" style="align-self:flex-start">Confirm</button>
              </form>
            </section>
          ) : keys.length >= STUDENT_PASSKEY_MAX ? (
            <p class="muted">You have the maximum of {STUDENT_PASSKEY_MAX} passkeys. Remove one to add another.</p>
          ) : !device ? (
            <p class="muted">Passkeys can only be added on one of your registered devices.</p>
          ) : (
            <section class="card stack">
              <div class="row" style="align-items:flex-end">
                <label class="field" style="flex:1 1 200px">Name for this device<input type="text" id="pk-name" maxlength={60} placeholder="e.g. My iPhone" /></label>
                <button class="btn btn-primary" type="button" data-pk="add">Add a passkey</button>
              </div>
            </section>
          )}
        </>
      )}
      <script dangerouslySetInnerHTML={{ __html: WEBAUTHN_JS + PASSKEY_PAGE_JS }} />
    </PortalLayout>,
  );
}

const activeDevice = async (db: D1Database, userId: number, hash: string | null) =>
  !!hash && !!(await db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND device_hash = ? AND status = 'active'").bind(userId, hash).first());

/** May this student change passkeys now? (verified email and phone, recent password + codes, approved device) */
async function studentMayChange(c: Context<AppEnv>) {
  const user = c.get('user')!;
  const s = c.get('session')!;
  if (!user.email_verified_at || !user.phone_verified_at) return 'Verify your email and phone first.';
  if (!(await hasTicket(c.env.DB, s.tokenHash))) return 'Please confirm it’s you first (password and codes).';
  if (!(await activeDevice(c.env.DB, user.id, s.deviceHash ?? null))) return 'Passkeys can only be changed on a registered device.';
  return null;
}

passkeyRoutes.post('/account/passkeys/send-codes', requireUser, async (c) => {
  const user = c.get('user')!;
  if (isStaff(user) || !user.email_verified_at || !user.phone_verified_at || !user.phone) return c.redirect('/account/passkeys');
  const a = await sendCode(c.env, user.id, 'email', 'passkey', user.email);
  const b = await sendCode(c.env, user.id, 'sms', 'passkey', user.phone);
  return c.redirect('/account/passkeys?' + (a.ok && b.ok ? 'ok=1' : 'error=' + encodeURIComponent(a.error || b.error || 'We couldn’t send the codes.')));
});

passkeyRoutes.post('/account/passkeys/check', requireUser, async (c) => {
  const user = c.get('user')!;
  if (isStaff(user)) return c.redirect('/account/passkeys');
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const row = await db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string; password_salt: string }>();
  const pwOk = !!row && (await verifyPassword(String(f.password ?? ''), row.password_hash, row.password_salt));
  const e = await checkCode(db, user.id, 'email', 'passkey', String(f.email_code ?? ''));
  const m = await checkCode(db, user.id, 'sms', 'passkey', String(f.sms_code ?? ''));
  if (!pwOk || e !== 'ok' || m !== 'ok') {
    await audit(db, { actorId: user.id, action: 'passkey.check_failed', targetUserId: user.id, ip: ip(c) });
    return c.redirect('/account/passkeys?error=' + encodeURIComponent(e === 'locked' || m === 'locked' ? 'Too many wrong codes. Send new codes and try again.' : 'The password or a code isn’t right.'));
  }
  await grantTicket(db, c.get('session')!.tokenHash);
  return c.redirect('/account/passkeys?ok=1');
});

passkeyRoutes.get('/account/passkeys', requireUser, async (c) => {
  const user = c.get('user')!;
  if (!isStaff(user)) return studentPasskeysPage(c);
  const db = c.env.DB;
  const [keys, left, required] = await Promise.all([passkeysOf(db, user.id), recoveryCodesLeft(db, user.id), passkeysRequired(db, user)]);
  const fresh = freshlyConfirmed(c);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Passkeys" active="account" user={user}>
      <Eyebrow>Account security</Eyebrow>
      <h1>Passkeys</h1>
      {keys.length === 0 && required && <Flash kind="error">Staff accounts need a passkey. Add one now to continue to the staff tools.</Flash>}
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">A passkey is a sign-in tied to this website that can’t be phished: your phone or computer confirms it with Face ID, Touch ID, Windows Hello or a security key. After your password, you’ll confirm each sign-in and every owner-only change with it.</p>
      <p id="pk-msg" class="flash" hidden role="status"></p>
      <section class="card stack">
        <h2 style="margin:0">Your passkeys</h2>
        {keys.length === 0 ? <p class="muted" style="margin:0">None yet.</p> : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Name</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col"></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr>
                  <td>{k.name}</td>
                  <td class="small muted">{k.created_at.slice(0, 10)}</td>
                  <td class="small muted">{k.last_used_at?.slice(0, 16) ?? '—'}</td>
                  <td>{keys.length > 1 && <form method="post" action={`/account/passkeys/${k.id}/remove`}><button class="btn btn-ghost btn-sm" type="submit">Remove</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <div class="row" style="align-items:flex-end">
          <label class="field" style="flex:1 1 200px">Name for this device<input type="text" id="pk-name" maxlength={60} placeholder="e.g. iPhone" /></label>
          {keys.length > 0 && !fresh ? (
            <button class="btn btn-outline" type="button" data-pk="auth" data-purpose="stepup" data-next="/account/passkeys">Confirm with a passkey to add another</button>
          ) : (
            <button class="btn btn-primary" type="button" data-pk="add">Add a passkey</button>
          )}
        </div>
        <p class="muted small" style="margin:0">Add a second passkey on another device (or a security key) so losing one device doesn’t lock you out. To remove a passkey, you must have another one.</p>
      </section>
      <section class="card stack" id="pk-codes" hidden>
        <h2 style="margin:0">Your recovery codes</h2>
        <p style="margin:0">Each code works once, if you lose your passkeys. Store them somewhere safe and private (a password manager or printed in a safe place). They won’t be shown again.</p>
        <pre style="font-size:18px;letter-spacing:1px;background:#f4f3ef;padding:12px;border-radius:8px"></pre>
        <a class="btn btn-primary" href="/dashboard" id="pk-done" hidden style="align-self:flex-start">I’ve saved them — continue</a>
      </section>
      {keys.length > 0 && (
        <section class="card stack">
          <h2 style="margin:0">Recovery codes</h2>
          <p class="muted" style="margin:0">{left} unused code{left === 1 ? '' : 's'} left. Making new codes cancels the old ones.</p>
          {fresh ? (
            <form method="post" action="/account/passkeys/codes"><button class="btn btn-outline" type="submit">Make new recovery codes</button></form>
          ) : (
            <button class="btn btn-outline" type="button" data-pk="auth" data-purpose="stepup" data-next="/account/passkeys" style="align-self:flex-start">Confirm with my passkey to make new codes</button>
          )}
        </section>
      )}
      <script dangerouslySetInnerHTML={{ __html: WEBAUTHN_JS + PASSKEY_PAGE_JS }} />
    </PortalLayout>,
  );
});

passkeyRoutes.post('/account/passkeys/options', requireUser, async (c) => {
  const user = c.get('user')!;
  if (!isStaff(user)) {
    const why = await studentMayChange(c);
    if (why) return c.json({ error: why }, 403);
    if ((await passkeysOf(c.env.DB, user.id)).length >= STUDENT_PASSKEY_MAX) return c.json({ error: `You can have at most ${STUDENT_PASSKEY_MAX} passkeys.` }, 403);
    return c.json(await registrationOptions(c, user, c.get('session')!.tokenHash));
  }
  // Adding a further passkey is a sensitive change: the session must have been confirmed recently.
  if ((await hasPasskey(c.env.DB, user.id)) && !freshlyConfirmed(c)) return c.json({ error: 'Please confirm it’s you first (Admin → confirm), then add the passkey.' }, 403);
  return c.json(await registrationOptions(c, user, c.get('session')!.tokenHash));
});

passkeyRoutes.post('/account/passkeys/verify', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  if (!isStaff(user)) {
    const why = await studentMayChange(c);
    if (why) return c.json({ ok: false, error: why }, 403);
    if ((await passkeysOf(db, user.id)).length >= STUDENT_PASSKEY_MAX) return c.json({ ok: false, error: `You can have at most ${STUDENT_PASSKEY_MAX} passkeys.` }, 403);
    const b = await json(c);
    const r = await finishRegistration(c, user, c.get('session')!.tokenHash, b.response, String(b.name ?? ''));
    if (!r.ok) return c.json(r, 400);
    await audit(db, { actorId: user.id, action: 'passkey.added', targetUserId: user.id, ip: ip(c) });
    await notify(c.env, user.id, { kind: 'security', title: 'A passkey was added to your account', body: 'If this wasn’t you, sign in with your password, remove it in My account → Passkeys, change your password and contact USMLE100.', sms: true });
    return c.json({ ok: true });
  }
  const first = !(await hasPasskey(db, user.id));
  if (!first && !freshlyConfirmed(c)) return c.json({ ok: false, error: 'Please confirm it’s you first.' }, 403);
  const b = await json(c);
  const r = await finishRegistration(c, user, c.get('session')!.tokenHash, b.response, String(b.name ?? ''));
  if (!r.ok) return c.json(r, 400);
  // Setting up the first passkey counts as a fresh confirmation for this sign-in.
  await db.prepare('UPDATE sessions SET passkey_id = ?, reauth_at = ? WHERE token_hash = ?').bind(r.id, Math.floor(Date.now() / 1000), c.get('session')!.tokenHash).run();
  await audit(db, { actorId: user.id, action: 'passkey.added', targetUserId: user.id, ip: ip(c) });
  const codes = first ? await newRecoveryCodes(db, user.id) : undefined;
  return c.json({ ok: true, codes });
});

passkeyRoutes.post('/account/passkeys/:id{[0-9]+}/remove', requireUser, async (c) => {
  const user = c.get('user')!;
  if (!isStaff(user)) {
    const why = await studentMayChange(c);
    if (why) return c.redirect('/account/passkeys?error=' + encodeURIComponent(why));
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    await db.batch([
      db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(id, user.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND passkey_id = ? AND token_hash <> ?').bind(user.id, id, c.get('session')!.tokenHash),
    ]);
    await audit(db, { actorId: user.id, action: 'passkey.removed', targetUserId: user.id, detail: { id }, ip: ip(c) });
    await notify(c.env, user.id, { kind: 'security', title: 'A passkey was removed from your account', body: 'If this wasn’t you, change your password and contact USMLE100.', sms: true });
    return c.redirect('/account/passkeys?ok=1');
  }
  if (!freshlyConfirmed(c)) return c.redirect('/account/passkeys?error=' + encodeURIComponent('Confirm with a passkey first.'));
  const db = c.env.DB;
  const count = (await passkeysOf(db, user.id)).length;
  if (count < 2) return c.redirect('/account/passkeys?error=' + encodeURIComponent('Add another passkey before removing this one.'));
  const id = Number(c.req.param('id'));
  await db.batch([
    db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(id, user.id),
    // Sign-ins made with that passkey end too.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND passkey_id = ? AND token_hash <> ?').bind(user.id, id, c.get('session')!.tokenHash),
  ]);
  await audit(db, { actorId: user.id, action: 'passkey.removed', targetUserId: user.id, detail: { id }, ip: ip(c) });
  return c.redirect('/account/passkeys?ok=1');
});

passkeyRoutes.post('/account/passkeys/codes', requireUser, async (c) => {
  const user = c.get('user')!;
  if (!isStaff(user) || !freshlyConfirmed(c) || !(await hasPasskey(c.env.DB, user.id))) return c.redirect('/account/passkeys?error=' + encodeURIComponent('Confirm with a passkey first.'));
  const codes = await newRecoveryCodes(c.env.DB, user.id);
  await audit(c.env.DB, { actorId: user.id, action: 'passkey.codes_renewed', targetUserId: user.id, ip: ip(c) });
  c.header('Cache-Control', 'no-store');
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Recovery codes" active="account" user={user}>
      <h1>New recovery codes</h1>
      <p>Your old codes no longer work. Each of these works once. Store them somewhere safe; they won’t be shown again.</p>
      <pre style="font-size:18px;letter-spacing:1px;background:#f4f3ef;padding:12px;border-radius:8px">{codes.join('\n')}</pre>
      <a class="btn btn-primary" href="/account/passkeys">Done</a>
    </PortalLayout>,
  );
});

// ---------- Second step of a staff sign-in, and fresh confirmation ----------

passkeyRoutes.get('/account/passkey/sign-in', requireUser, async (c) => {
  const s = c.get('session')!;
  if (!s.verifyPending || s.verifyReason !== 'passkey') return c.redirect('/dashboard');
  const next = safeNext(c.req.query('next'));
  return c.html(
    <PublicLayout title="Confirm with your passkey" user={null} plain>
      <main class="wrap page" style="max-width:520px;padding-top:56px;padding-bottom:72px">
        <Eyebrow>USMLE100 staff sign-in</Eyebrow>
        <h1>Confirm with your passkey</h1>
        <p class="muted">Your password was right. Now confirm it’s you with your passkey.</p>
        {c.req.query('error') && <Flash kind="error">That recovery code isn’t valid or was already used.</Flash>}
        <p id="pk-msg" class="flash" hidden role="status"></p>
        <button class="btn btn-primary btn-block" type="button" data-pk="auth" data-purpose="signin" data-next={next}>Use my passkey</button>
        <details style="margin-top:24px">
          <summary>Lost your passkey?</summary>
          <form method="post" action="/account/passkey/recovery" class="stack" style="gap:10px;margin-top:10px">
            <input type="hidden" name="next" value={next} />
            <label class="field">Recovery code<input type="text" name="code" required autocomplete="one-time-code" placeholder="XXXXX-XXXXX" /></label>
            <button class="btn btn-outline" type="submit">Use recovery code</button>
          </form>
        </details>
        <form method="post" action="/sign-out" style="margin-top:16px"><button class="btn btn-ghost" type="submit">Cancel and sign out</button></form>
        <script dangerouslySetInnerHTML={{ __html: WEBAUTHN_JS + PASSKEY_PAGE_JS }} />
      </main>
    </PublicLayout>,
  );
});

passkeyRoutes.post('/account/passkey/options', requireUser, async (c) => {
  const user = c.get('user')!;
  const purpose = (await json(c)).purpose === 'stepup' ? 'stepup' : 'signin';
  if (!(await hasPasskey(c.env.DB, user.id))) return c.json({ error: 'No passkey is set up for this account.' }, 400);
  return c.json(await authenticationOptions(c, user.id, c.get('session')!.tokenHash, purpose));
});

passkeyRoutes.post('/account/passkey/verify', requireUser, async (c) => {
  const user = c.get('user')!;
  const s = c.get('session')!;
  const b = await json(c);
  const purpose = b.purpose === 'stepup' ? 'stepup' : 'signin';
  const id = await finishAuthentication(c, user.id, s.tokenHash, purpose, b.response);
  if (!id) {
    await audit(c.env.DB, { actorId: user.id, action: 'passkey.failed', targetUserId: user.id, detail: { purpose }, ip: ip(c) });
    return c.json({ ok: false, error: 'That passkey wasn’t accepted.' }, 401);
  }
  const t = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`UPDATE sessions SET reauth_at = ?, passkey_id = ?${purpose === 'signin' ? ", verify_pending = 0, verify_reason = NULL" : ''} WHERE token_hash = ?`).bind(t, id, s.tokenHash).run();
  await audit(c.env.DB, { actorId: user.id, action: purpose === 'signin' ? 'passkey.signin' : 'owner.confirmed', targetUserId: user.id, detail: { passkey: id }, ip: ip(c) });
  return c.json({ ok: true });
});

/** Lost passkey: a one-time recovery code finishes the sign-in; the owner is alerted and must set up a new passkey. */
passkeyRoutes.post('/account/passkey/recovery', requireUser, async (c) => {
  const user = c.get('user')!;
  const s = c.get('session')!;
  const f = await c.req.parseBody();
  if (!s.verifyPending || s.verifyReason !== 'passkey') return c.redirect('/dashboard');
  const db = c.env.DB;
  if (!(await useRecoveryCode(db, user.id, String(f.code ?? '')))) {
    await audit(db, { actorId: user.id, action: 'passkey.recovery_failed', targetUserId: user.id, ip: ip(c) });
    return c.redirect('/account/passkey/sign-in?error=1');
  }
  // The code is a high-entropy secret only the account holder saved, so it also lets them set up a new passkey now.
  await db.prepare('UPDATE sessions SET verify_pending = 0, verify_reason = NULL, reauth_at = ? WHERE token_hash = ?').bind(Math.floor(Date.now() / 1000), s.tokenHash).run();
  await audit(db, { actorId: user.id, action: 'passkey.recovery_used', targetUserId: user.id, detail: { left: await recoveryCodesLeft(db, user.id) }, ip: ip(c) });
  await db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', 'recovery-code', ?, ?)").bind(user.id, `${user.name} signed in with a recovery code instead of a passkey.`).run();
  return c.redirect('/account/passkeys?ok=1');
});
