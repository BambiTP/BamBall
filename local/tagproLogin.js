// tagproLogin.js - homepage glue for TagPro identity, built on top of the
// portable TagproAuth library (local/tagproAuthLib.js). The actual login
// flow (paste a profile URL, follow the flair-change instructions, poll
// until verified) lives on its own page now - see tagpro-login.html -
// this file just renders whatever TagproAuth.getIdentity() already says
// and hands off to that page for anyone who isn't logged in yet.

var DISPLAY_NAME_KEY = 'bamball_display_name';

function loadDisplayNamePref() {
  try { return localStorage.getItem(DISPLAY_NAME_KEY) || ''; } catch (err) { return ''; }
}

function saveDisplayNamePref(name) {
  try { localStorage.setItem(DISPLAY_NAME_KEY, name); } catch (err) {}
}

// The name + identity actually used when creating/joining a group -
// main.js reads this right before webrtcTransport.createGroup/joinGroup.
// Only sends the tagpro token (and so only gets the green verified name +
// authed flag - see handleOutgoingFor's 'identify' case in
// webrtcTransport.js/node-host/hostCli.js, which requires an actual
// verified token before setting authed:true, never just a matching-looking
// name) when the saved display name still matches the verified
// reservedName exactly. Editing the name field away from it - see
// initIdentityUI's input listener below, which stays editable even while
// logged in - is how you deliberately drop back to an unverified custom
// name without logging out.
function currentIdentity() {
  var tagpro = TagproAuth.getIdentity();
  var typedName = loadDisplayNamePref().trim();
  if (tagpro && typedName === tagpro.reservedName) return { name: tagpro.reservedName, tagpro: tagpro };
  return { name: typedName || null, tagpro: null };
}

function initIdentityUI() {
  var nameInput = document.getElementById('displayNameInput');
  var loginBtn  = document.getElementById('tagproLoginBtn');
  if (!nameInput || !loginBtn) return;

  // Green only while the field's current text still matches the verified
  // name exactly - the same condition currentIdentity() uses to decide
  // whether to actually claim it, so the color never promises something
  // the join packet doesn't back up.
  function updateNameColor() {
    var identity = TagproAuth.getIdentity();
    nameInput.style.color = (identity && nameInput.value.trim() === identity.reservedName) ? '#4caf50' : '';
  }

  function render() {
    var identity = TagproAuth.getIdentity();
    // Pre-fills with the verified name only if nothing was ever saved -
    // an existing custom preference (typed before ever logging in) is
    // left alone rather than silently overwritten. tagpro-login.html's
    // own "verified" step separately seeds this on a FRESH login, which
    // is the case that actually needs the auto-fill.
    if (identity && !loadDisplayNamePref()) saveDisplayNamePref(identity.reservedName);
    nameInput.value = loadDisplayNamePref();
    loginBtn.textContent = identity ? 'Log out of TagPro' : 'Log in with TagPro';
    updateNameColor();
  }

  loginBtn.addEventListener('click', function () {
    if (TagproAuth.getIdentity()) { TagproAuth.logout(); render(); return; }
    // Strips a trailing "index.html" rather than exact-matching
    // "/index.html" so this stays correct under any hosting path, not
    // just a domain root - this page is never meant to be linked/
    // returned-to with an explicit index.html, but the directory it's IN
    // could be "/" (Cloudflare Pages, a domain root) or "/BamBall/" (a
    // GitHub Pages project page, which serves this repo at
    // /<repo-name>/, not "/") depending on where it's deployed.
    var here = location.pathname.replace(/index\.html$/, '');
    // tagpro-login.html is a standalone page with its own SERVER_URL
    // default (production) - passing this game's own webrtcTransport.
    // workerUrl through explicitly means "log in with TagPro" from THIS
    // homepage always talks to whichever backend this homepage itself is
    // already using (e.g. a local wrangler dev during testing), instead of
    // silently falling back to production and failing with a confusing
    // "not found" the moment the two disagree.
    //
    // Relative "tagpro-login", not an absolute "/tagpro-login" -
    // tagpro-login.html is a sibling of this page in the same directory,
    // and a leading "/" would walk straight back into the same
    // hosting-path problem `here` above just worked around.
    location.href = 'tagpro-login?return=' + encodeURIComponent(here + location.search)
      + '&server=' + encodeURIComponent(webrtcTransport.workerUrl);
  });

  // Editable at all times, logged in or not - typing away from the
  // verified reservedName is exactly how currentIdentity() above decides
  // to drop the tagpro token (and so the green name/authed flag) without
  // requiring a full log-out.
  nameInput.addEventListener('input', function () {
    saveDisplayNamePref(nameInput.value.slice(0, 20));
    updateNameColor();
  });

  render();
}
