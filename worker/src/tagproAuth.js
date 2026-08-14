// tagproAuth.js - "login with your real TagPro flair": proves someone
// controls a specific real TagPro account by having them live-change their
// own equipped flair through a set sequence, observed via
// tagpro.koalabeast.com's public profile API - confirmed live (during
// design) to be a public, unauthenticated JSON endpoint. Only the real
// account owner can change their own flair in real time, so watching that
// sequence happen IS the proof of ownership; no cooperation from TagPro,
// no OAuth, no password ever touches this app.
//
// Routes (wired in index.js):
//   POST /api/tagpro/login/start { profileId }
//     -> records the account's CURRENT flair, tells the client what to do
//        first, and mints a random `session` value returned only to this
//        caller - required on every login/check below so a login can only
//        be checked (and its resulting token claimed) by whoever actually
//        started it, not by any other party who happens to know the same
//        profileId (which is meant to be public/shareable, so is not
//        itself a secret). Refuses (409) to mint a second session while
//        one's already active for the same profileId - see the long
//        comment on this in handleLoginStart for why that matters and
//        what it doesn't fix.
//   POST /api/tagpro/login/check { profileId, session }  (the client calls
//        this once per user action - e.g. a "Confirm" button click after
//        they say they've made the change - not on a background timer)
//     -> re-fetches the live profile every call, advances a small state
//        machine: [await-non-blank ->] await-pencil -> await-blank ->
//        verified. await-non-blank is skipped entirely if the account's
//        flair wasn't already blank when login/start was called - see
//        handleLoginStart. It exists because if the FIRST required step
//        were just "clear your flair" the way this used to work, an
//        account that already happened to have no flair equipped would
//        satisfy it for free, without proving any live action at all;
//        requiring a detour through some other, non-blank flair first
//        guarantees every remaining step needs a genuine, observed change.
//   POST /api/tagpro/verify { profileId, reservedName, verifiedAt, token }
//     -> recomputes the HMAC a completed login/check minted and compares.
//        This is what a HOST calls (webrtcTransport.js) to check a joining
//        peer's claimed identity - a browser can't safely hold AUTH_SECRET
//        itself, so trusting a peer's self-reported token unverified would
//        let anyone claim any name.
//
// State for an IN-PROGRESS login lives in TAGPRO_LOGIN (KV, short TTL so
// an abandoned attempt cleans itself up rather than lingering forever). A
// COMPLETED login needs no further server-side storage at all - it mints a
// signed token instead, which the client keeps in localStorage as its
// persistent identity (same layer local/localSettings-style per-user state
// already uses) and re-presents on every future join.

import { json } from './http.js';

const TAGPRO_PROFILE_BASE = 'https://tagpro.koalabeast.com/profiles/';
const LOGIN_KEY_PREFIX    = 'login:';
const LOGIN_TTL_SECONDS   = 600; // 10 minutes - plenty for someone to go flip a flair on another tab
// A completed login's token is a bearer credential with no server-side
// session to revoke - this bounds how long a leaked one stays useful. Past
// this age handleVerifyToken rejects it and the client just redoes the
// (quick, free) flair dance for a fresh one - see local/tagproAuthLib.js's
// getIdentity()/poll(), which already re-verifies through the host on every
// join rather than assuming a locally-stored identity is still good.
const TOKEN_MAX_AGE_MS    = 30 * 24 * 60 * 60 * 1000; // 30 days

// Confirmed live against a real account: equipping "Pencil" (the
// "Degrees of Kevin Bacon" family's 2-degree entry) and checking
// https://tagpro.koalabeast.com/profiles/<id> showed selectedFlair ===
// "degree.pencil" - a DOT, not the hyphen the flair catalog page's own
// CSS class ("degree-pencil") would suggest. Deliberately one named
// constant so a future correction stays a one-line change, not a hunt
// through this file.
const VERIFICATION_FLAIR_ID = 'degree.pencil';

function isNoFlair(flair) {
  // Confirmed live against a real account: clearing a flair reports
  // selectedFlair === "" (empty string) - falsy, so the broad check below
  // already covered it correctly without needing a change.
  return !flair;
}

async function fetchTagproProfile(profileId) {
  var res = await fetch(TAGPRO_PROFILE_BASE + encodeURIComponent(profileId));
  if (!res.ok) throw new Error('could not reach that TagPro profile');
  var data = await res.json().catch(function () { return null; });
  // The endpoint returns a one-element array, confirmed live during design.
  var profile = Array.isArray(data) ? data[0] : data;
  if (!profile) throw new Error('TagPro profile not found');
  return { reservedName: profile.reservedName || null, selectedFlair: profile.selectedFlair || null };
}

// Plain `===` on the hex digest short-circuits on the first differing
// character - a textbook timing side channel on a value that gates real
// identity claims, even if actually exploiting it over the internet's
// jitter is hard. Always walks the full length regardless of where a
// mismatch is, so the comparison itself doesn't leak how much of the
// guess was right. Equal-length is required going in (both sides are a
// fixed-length SHA-256 hex digest here), same precondition
// crypto.timingSafeEqual imposes.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  var key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  var signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function tokenMessage(profileId, reservedName, verifiedAt) {
  return profileId + '|' + reservedName + '|' + verifiedAt;
}

function readProfileId(body) {
  var profileId = body && body.profileId;
  if (typeof profileId !== 'string' || !profileId) return null;
  // '|' is tokenMessage's own field delimiter - rejected rather than risk
  // two different (profileId, reservedName) pairs ever signing to the same
  // joined string (e.g. profileId "a|b", reservedName "c" vs. profileId
  // "a", reservedName "b|c" both join to "a|b|c|<verifiedAt>"). No real
  // TagPro profileId should ever contain one; this only ever rejects an
  // attacker deliberately trying to embed one.
  if (profileId.indexOf('|') !== -1) return null;
  return profileId;
}

function readSession(body) {
  var session = body && body.session;
  return typeof session === 'string' && session ? session : null;
}

// justAdvanced: true right after a check moves pending.state forward (so
// the message reads as "good, now do the next thing"), false when a check
// finds the account still sitting in the same state it already was in (so
// it reads as "that hasn't happened yet, still waiting") - same
// distinction the client-facing "Confirm" button relies on to tell someone
// their last click was too early versus that it's time for the next step.
function instructionsFor(state, justAdvanced) {
  if (state === 'await-non-blank') {
    return justAdvanced
      ? 'Your flair is already set to None - set it to any OTHER flair first, then confirm.'
      : 'Still set to None - set your flair to any flair OTHER than None, then confirm.';
  }
  if (state === 'await-pencil') {
    return justAdvanced
      ? 'Now set your flair to "' + VERIFICATION_FLAIR_ID + '", then confirm.'
      : 'Still waiting - set your flair to "' + VERIFICATION_FLAIR_ID + '", then confirm.';
  }
  if (state === 'await-blank') {
    return justAdvanced
      ? 'Almost done - now set your flair back to None, then confirm.'
      : 'Still waiting - set your flair back to None, then confirm.';
  }
  return '';
}

export async function handleLoginStart(request, env) {
  var body = await request.json().catch(function () { return null; });
  var profileId = readProfileId(body);
  if (!profileId) return json({ error: 'missing profileId' }, 400);

  // Refuse to mint a second session while one's already active for this
  // profileId, rather than unconditionally overwriting it (an earlier
  // version of this did). That reopened exactly the race the session
  // check in handleLoginCheck exists to close: this route has nothing to
  // authenticate against yet - that's the whole premise of it - so
  // anyone could otherwise call it for a target's public profileId to
  // mint themselves a fresh, currently-valid session, silently
  // invalidating whatever session the real account owner's own tab was
  // using. Since the state machine's progress reflects the real
  // account's actual live flair regardless of who's asking, whoever
  // holds the currently-valid session receives the token the moment the
  // real owner performs the real flair change on their own account.
  //
  // This doesn't make the race impossible - whoever calls login/start
  // FIRST for a given profileId still wins that session, and there's no
  // way to give the real account owner special standing over anyone else
  // at this unauthenticated stage (no OAuth, no password - that's the
  // entire premise of this login flow; TagPro's flair system is also a
  // small fixed set of options, not free text, so there's no way to embed
  // a per-attempt secret in what someone's asked to set either). What
  // this does do is shrink the window from "any later caller can hijack
  // an in-progress attempt at any moment" down to "only whoever was
  // first, within one LOGIN_TTL_SECONDS window, ever gets a working
  // session." A user who loses their session client-side (e.g. reloads
  // mid-login) has to wait out the existing entry's TTL before retrying.
  var existingRaw = await env.TAGPRO_LOGIN.get(LOGIN_KEY_PREFIX + profileId);
  if (existingRaw) {
    return json({
      error: 'a login is already in progress for this profile - finish that attempt, or wait a few minutes for it to expire and try again',
      state: JSON.parse(existingRaw).state,
    }, 409);
  }

  var profile;
  try { profile = await fetchTagproProfile(profileId); } catch (e) { return json({ error: e.message }, 502); }

  // A random per-attempt secret, handed back only to whoever gets this
  // response, and required on every /login/check for this profileId (see
  // readSession/handleLoginCheck below). profileId itself is meant to be
  // public - it's copy-pasted straight out of a profile URL - so without
  // this, anyone who knows a target's profileId could poll /login/check
  // concurrently with them and race to grab the resulting token the moment
  // the real account's flair actually changes. The flair dance proves
  // control of the TagPro account; this is what proves the caller polling
  // for the result is the same one who asked for that proof.
  var session = crypto.randomUUID();
  // See this file's header comment for why await-non-blank exists at all -
  // skipped straight to await-pencil for the (overwhelmingly common) case
  // where the account already has some flair equipped.
  var state = isNoFlair(profile.selectedFlair) ? 'await-non-blank' : 'await-pencil';

  await env.TAGPRO_LOGIN.put(LOGIN_KEY_PREFIX + profileId, JSON.stringify({
    state: state,
    originalFlair: profile.selectedFlair,
    session: session,
  }), { expirationTtl: LOGIN_TTL_SECONDS });

  return json({ state: state, session: session, instructions: instructionsFor(state, true) });
}

export async function handleLoginCheck(request, env) {
  var body = await request.json().catch(function () { return null; });
  var profileId = readProfileId(body);
  if (!profileId) return json({ error: 'missing profileId' }, 400);
  var session = readSession(body);

  var raw = await env.TAGPRO_LOGIN.get(LOGIN_KEY_PREFIX + profileId);
  if (!raw) return json({ error: 'no login in progress for this profile - start again' }, 404);
  var pending = JSON.parse(raw);

  // Same response as "no login in progress" rather than a distinct "wrong
  // session" error - otherwise the error itself would let someone probe
  // whether a login happens to be in progress for a given profileId at all.
  if (!session || session !== pending.session) {
    return json({ error: 'no login in progress for this profile - start again' }, 404);
  }

  var profile;
  try { profile = await fetchTagproProfile(profileId); } catch (e) { return json({ error: e.message }, 502); }

  if (pending.state === 'await-non-blank') {
    if (isNoFlair(profile.selectedFlair)) {
      return json({ state: 'await-non-blank', instructions: instructionsFor('await-non-blank', false) });
    }
    pending.state = 'await-pencil';
    await env.TAGPRO_LOGIN.put(LOGIN_KEY_PREFIX + profileId, JSON.stringify(pending), { expirationTtl: LOGIN_TTL_SECONDS });
    return json({ state: 'await-pencil', instructions: instructionsFor('await-pencil', true) });
  }

  if (pending.state === 'await-pencil') {
    if (profile.selectedFlair !== VERIFICATION_FLAIR_ID) {
      return json({ state: 'await-pencil', instructions: instructionsFor('await-pencil', false) });
    }
    pending.state = 'await-blank';
    await env.TAGPRO_LOGIN.put(LOGIN_KEY_PREFIX + profileId, JSON.stringify(pending), { expirationTtl: LOGIN_TTL_SECONDS });
    return json({ state: 'await-blank', instructions: instructionsFor('await-blank', true) });
  }

  if (pending.state === 'await-blank') {
    if (!isNoFlair(profile.selectedFlair)) {
      return json({ state: 'await-blank', instructions: instructionsFor('await-blank', false) });
    }
    await env.TAGPRO_LOGIN.delete(LOGIN_KEY_PREFIX + profileId); // login's done - nothing further to track server-side
    var verifiedAt = Date.now();
    var reservedName = profile.reservedName || profileId;
    var token = await hmacHex(env.AUTH_SECRET, tokenMessage(profileId, reservedName, verifiedAt));
    return json({
      state: 'verified',
      profileId: profileId,
      reservedName: reservedName,
      verifiedAt: verifiedAt,
      token: token,
      // The flow already ends with the account back on None by design (the
      // await-blank step above) - originalFlair is only worth mentioning
      // if they'd actually had something else equipped to begin with.
      instructions: 'Verified!' + (pending.originalFlair ? ' Feel free to set your flair back to ' + pending.originalFlair + '.' : ''),
    });
  }

  return json({ error: 'unexpected login state' }, 500);
}

export async function handleVerifyToken(request, env) {
  var body = await request.json().catch(function () { return null; });
  if (!body || !body.profileId || !body.reservedName || !body.verifiedAt || !body.token) {
    return json({ valid: false });
  }
  var expected = await hmacHex(env.AUTH_SECRET, tokenMessage(body.profileId, body.reservedName, body.verifiedAt));
  // Only trust verifiedAt for the age check once the signature over it has
  // actually checked out - before that it's just a client-supplied number,
  // and a forged one (e.g. a huge value to dodge the expiry check below)
  // can't produce a matching `expected` without knowing AUTH_SECRET anyway.
  var signatureValid = timingSafeEqual(expected, body.token);
  var stillFresh = signatureValid && (Date.now() - body.verifiedAt <= TOKEN_MAX_AGE_MS);
  return json({ valid: stillFresh, reservedName: body.reservedName });
}
