// tagproAuthLib.js - "login with your real TagPro flair," portable client.
//
// DROP-IN: this file has zero dependencies on the rest of this project (no
// appEvents, no game state, nothing BamBall-specific) - just fetch() and
// localStorage, both plain browser globals. Copy this one file into any
// other codebase and it works as-is, loaded as a plain <script> tag (or
// required as a CommonJS module - see the export line at the bottom).
//
// It talks to a matching server (this project's worker/src/tagproAuth.js -
// NOT included here, that half is project-specific and stays where it is)
// over 3 POST routes: /api/tagpro/login/start, /login/check, and the
// separate /api/tagpro/verify a HOST calls to check a peer's claim (see
// that file's own header comment for the full protocol and why watching a
// live flair-change sequence proves TagPro account ownership). Every
// function here that talks to the network takes the server's base URL as
// its own explicit argument - nothing is hardcoded, so the same file works
// against any deployment, any port, local or production.
//
// Usage:
//   var profileId = TagproAuth.extractProfileId(userPastedText);
//   TagproAuth.startLogin(serverUrl, profileId).then(function (result) {
//     // result: { profileId, session, state, instructions } - state is
//     // whichever of the server's states applies first (see worker/src/
//     // tagproAuth.js's own header comment for the full list/order).
//   });
//
//   // Manual/confirm-button-driven (what this project's own tagpro-login.html
//   // does): call checkLogin once per user action, e.g. a "Confirm" button
//   // clicked after the user says they've made the change on TagPro's site -
//   // NOT on a timer. checkLogin does NOT auto-save on 'verified' - call
//   // saveIdentity yourself with the result when driving it this way.
//   TagproAuth.checkLogin(serverUrl, profileId, result.session).then(function (result) { ... });
//
//   // Or, background-polled instead:
//   var stop = TagproAuth.poll(serverUrl, profileId, result.session, {
//     onUpdate: function (result, err) { ... }, // fires on every check
//     intervalMs: 3000, // optional, defaults to 3000
//   });
//   // stop() cancels polling - poll() also calls it automatically once
//   // state reaches 'verified' (and saves the identity for you at that
//   // point - see saveIdentity).
//   TagproAuth.getIdentity(); // -> { profileId, reservedName, verifiedAt, token } | null
//   TagproAuth.logout();

var TagproAuth = (function () {
  var STORAGE_KEY = 'tagpro_auth_identity';

  // Accepts a bare 24-character Mongo ObjectId, or any text containing one
  // (a pasted https://tagpro.koalabeast.com/profile/<id> or /profiles/<id>
  // URL both work identically - the site's user-facing page is /profile/
  // singular, the JSON API with the actual flair data is /profiles/
  // plural, and this doesn't care which one it's handed).
  function extractProfileId(input) {
    var text = String(input || '');
    var match = text.match(/[a-f0-9]{24}/i);
    return match ? match[0] : text.trim();
  }

  function getIdentity() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function saveIdentity(identity) {
    try {
      if (identity) localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (err) {}
  }

  function logout() { saveIdentity(null); }

  function apiCall(serverUrl, path, body) {
    return fetch(serverUrl.replace(/\/$/, '') + '/api/tagpro/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'request failed (status ' + res.status + ')');
        return data;
      });
    });
  }

  function startLogin(serverUrl, profileIdOrUrl) {
    var profileId = extractProfileId(profileIdOrUrl);
    return apiCall(serverUrl, 'login/start', { profileId: profileId })
      .then(function (data) { return Object.assign({ profileId: profileId }, data); });
  }

  function checkLogin(serverUrl, profileId, session) {
    return apiCall(serverUrl, 'login/check', { profileId: profileId, session: session });
  }

  // Lets an in-progress attempt's own session holder abandon it early
  // (e.g. a "Cancel" button) instead of it sitting locked for the rest of
  // its TTL - see worker/src/tagproAuth.js's handleLoginCancel for why the
  // session is required here too. Best-effort: always resolves (never
  // rejects), since a cancel that fails to reach the server just means the
  // old attempt lingers until its TTL expires rather than being freed
  // immediately - annoying, not broken, so callers don't need to handle
  // an error case here.
  function cancelLogin(serverUrl, profileId, session) {
    return apiCall(serverUrl, 'login/cancel', { profileId: profileId, session: session }).catch(function () {});
  }

  // Have the host's server confirm a PEER's self-reported identity token
  // (a browser can't safely hold the signing secret itself, so a claimed
  // token has to be checked against the server that minted it before
  // trusting it) - see worker/src/tagproAuth.js's handleVerifyToken.
  function verifyToken(serverUrl, identity) {
    return apiCall(serverUrl, 'verify', {
      profileId: identity.profileId,
      reservedName: identity.reservedName,
      verifiedAt: identity.verifiedAt,
      token: identity.token,
    }).then(function (data) { return !!data.valid; }).catch(function () { return false; });
  }

  // Polls checkLogin on an interval, calling onUpdate(result, error) every
  // time, until the login reaches 'verified' (saved automatically via
  // saveIdentity right before the callback fires) or a call fails (network
  // drop, expired login) - either way polling stops itself. Always safe to
  // call the returned stop() again yourself (e.g. the user navigates away
  // mid-login) - a second clearInterval on an already-cleared timer is a
  // no-op.
  function poll(serverUrl, profileId, session, options) {
    var onUpdate = (options && options.onUpdate) || function () {};
    var intervalMs = (options && options.intervalMs) || 3000;

    var timer = setInterval(function () {
      checkLogin(serverUrl, profileId, session).then(function (result) {
        if (result.state === 'verified') {
          saveIdentity({ profileId: result.profileId, reservedName: result.reservedName, verifiedAt: result.verifiedAt, token: result.token });
          stop();
        }
        onUpdate(result, null);
      }).catch(function (err) {
        stop();
        onUpdate(null, err);
      });
    }, intervalMs);

    function stop() { clearInterval(timer); }
    return stop;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    extractProfileId: extractProfileId,
    getIdentity: getIdentity,
    saveIdentity: saveIdentity,
    logout: logout,
    startLogin: startLogin,
    checkLogin: checkLogin,
    cancelLogin: cancelLogin,
    verifyToken: verifyToken,
    poll: poll,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TagproAuth;
if (typeof globalThis !== 'undefined') globalThis.TagproAuth = TagproAuth;
