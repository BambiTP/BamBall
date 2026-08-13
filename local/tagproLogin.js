// tagproLogin.js - homepage glue for TagPro identity, built on top of the
// portable TagproAuth library (local/tagproAuthLib.js). The actual login
// flow (paste a profile URL, follow the flair-change instructions, poll
// until verified) lives on its own page now - see tagpro-login.html -
// this file just renders whatever TagproAuth.getIdentity() already says
// and hands off to that page for anyone who isn't logged in yet.

var DISPLAY_NAME_KEY = 'bambipro_display_name';

function loadDisplayNamePref() {
  try { return localStorage.getItem(DISPLAY_NAME_KEY) || ''; } catch (err) { return ''; }
}

function saveDisplayNamePref(name) {
  try { localStorage.setItem(DISPLAY_NAME_KEY, name); } catch (err) {}
}

// The name + identity actually used when creating/joining a group -
// main.js reads this right before webrtcTransport.createGroup/joinGroup.
function currentIdentity() {
  var tagpro = TagproAuth.getIdentity();
  if (tagpro) return { name: tagpro.reservedName, tagpro: tagpro };
  return { name: loadDisplayNamePref().trim() || null, tagpro: null };
}

function initIdentityUI() {
  var nameInput = document.getElementById('displayNameInput');
  var loginBtn  = document.getElementById('tagproLoginBtn');
  if (!nameInput || !loginBtn) return;

  function render() {
    var identity = TagproAuth.getIdentity();
    if (identity) {
      nameInput.value = identity.reservedName;
      nameInput.disabled = true;
      nameInput.style.color = '#4caf50';
      loginBtn.textContent = 'Log out of TagPro';
    } else {
      nameInput.disabled = false;
      nameInput.style.color = '';
      nameInput.value = loadDisplayNamePref();
      loginBtn.textContent = 'Log in with TagPro';
    }
  }

  loginBtn.addEventListener('click', function () {
    if (TagproAuth.getIdentity()) { TagproAuth.logout(); render(); return; }
    // Strips a trailing "index.html" rather than exact-matching
    // "/index.html" so this stays correct under any hosting path, not
    // just a domain root - this page is never meant to be linked/
    // returned-to with an explicit index.html, but the directory it's IN
    // could be "/" (Cloudflare Pages, a domain root) or "/BambiPro/" (a
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

  nameInput.addEventListener('input', function () {
    if (TagproAuth.getIdentity()) return; // locked while logged in
    saveDisplayNamePref(nameInput.value.slice(0, 20));
  });

  render();
}
