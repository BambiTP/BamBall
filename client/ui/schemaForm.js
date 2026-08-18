// schemaForm.js - generic settings-panel builder used by local/
// controlPanel.js's Settings tab. Every row is driven entirely by
// settingsState.settingsSchema (sent once by the server) - a new setting
// added server-side needs zero new code here. A row does NOT apply as you
// type - editing the input just edits the input, same as any ordinary
// form; its own Apply button (or hitting Enter in it) is what actually
// sends that one key, and its Reset button puts the field back to its
// shipped default (engine/gameConfig.js for physics, engine/
// matchSettings.js's DEFAULT_SETTINGS for match) and applies that.

function schemaList(scope) {
  return (settingsState.settingsSchema && settingsState.settingsSchema[scope]) || [];
}

function schemaEntryFor(scope, key) {
  var list = schemaList(scope);
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i];
  }
  return null;
}

// Physics categories come from settingsState.physicsCategories (sent
// separately); match categories are derived from the schema entries
// themselves since there's no separate matchCategories field.
function categoriesFor(scope) {
  if (scope === 'physics') return settingsState.physicsCategories || {};

  var categories = {};
  var list = schemaList(scope);
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry.category) continue;
    if (!categories[entry.category]) categories[entry.category] = [];
    categories[entry.category].push(entry.key);
  }
  return categories;
}

function toDisplayValue(entry, raw) {
  if (raw === null || raw === undefined) return '';
  return entry && entry.scale ? raw / entry.scale : raw;
}

function fromDisplayValue(entry, raw) {
  return entry && entry.scale ? raw * entry.scale : raw;
}

// The value a Reset click puts back - the room's shipped starting value,
// not "whatever was last applied." NOT gameConfig itself - matchManager.js
// mutates that object in place on every updatePhysics() (Object.assign(
// config, next)), so by the time a leader has changed anything, gameConfig
// already IS the current live value, not the default. settingsState.
// physicsDefaults is the snapshot matchManager took of it before any
// mutation could happen (getPhysicsDefaults(), sent once in the schema
// packet - see client/state.js), so it stays correct no
// matter how many edits have happened since. matchSettingsDefaults doesn't
// have this problem (engine/matchSettings.js's validateSettings always
// spreads into a new object, never mutates DEFAULT_SETTINGS), but reading
// it from the same synced packet keeps both lookups symmetric. Falls back
// to the live globals only if asked before the schema packet has arrived.
function defaultValueFor(scope, key) {
  if (scope === 'physics') {
    if (settingsState.physicsDefaults) return settingsState.physicsDefaults[key];
    return typeof gameConfig !== 'undefined' ? gameConfig[key] : undefined;
  }
  if (scope === 'match') {
    if (settingsState.matchSettingsDefaults) return settingsState.matchSettingsDefaults[key];
    return typeof MatchSettings !== 'undefined' ? MatchSettings.DEFAULT_SETTINGS[key] : undefined;
  }
  return undefined;
}

function setInputDisplayValue(entry, input, raw) {
  if (input.type === 'checkbox') { input.checked = !!raw; return; }
  if (entry && entry.type === 'enum') { input.value = raw; return; }
  input.value = toDisplayValue(entry, raw);
}

// "gravityWellFalloff" -> "Gravity Well Falloff", purely cosmetic.
function formatKey(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, function (c) { return c.toUpperCase(); });
}

// Reads one input's current value back out in stored (not display) units -
// e.g. an empty string on a nullable field is `null`, a scaled field is
// multiplied back up. Returns undefined for a not-yet-finished number entry
// (an in-progress "-" or "" the browser hasn't rejected yet), which callers
// must treat as "no change to apply."
function readInputValue(scope, key, input) {
  var entry = schemaEntryFor(scope, key);

  if (input.type === 'checkbox') return input.checked;
  if (entry && entry.type === 'enum') return input.value;

  var rawStr = input.value.trim();
  if (entry && entry.nullable && rawStr === '') return null;
  var value = fromDisplayValue(entry, Number(rawStr));
  return isFinite(value) ? value : undefined;
}

// onApply(key, value), if given, is called only from this row's own Apply
// button (or Enter in the input) or its Reset button - never just from
// editing the input, so a leader can type into several fields without any
// of them going live until they actually say so.
function buildSettingRow(scope, key, values, onApply) {
  var entry = schemaEntryFor(scope, key);
  // A plain div, not a <label> wrapping the input - this row now also
  // holds Apply/Reset buttons, and a <label> would toggle a checkbox
  // input on ANY click inside it, buttons included.
  var row = document.createElement('div');
  row.className = 'settingRow';

  var name = document.createElement('span');
  name.textContent = formatKey(key) + (entry && entry.unit ? ' (' + entry.unit + ')' : '');
  row.appendChild(name);

  var controls = document.createElement('span');
  controls.className = 'settingRowControls';

  var input;
  var raw = values[key];

  if (entry && entry.type === 'bool') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!raw;
  } else if (entry && entry.type === 'enum') {
    input = document.createElement('select');
    for (var i = 0; i < entry.options.length; i++) {
      var opt = document.createElement('option');
      opt.value = entry.options[i];
      opt.textContent = entry.options[i];
      input.appendChild(opt);
    }
    input.value = raw;
  } else {
    input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = toDisplayValue(entry, raw);
  }
  input.setAttribute('data-key', key);
  controls.appendChild(input);

  if (onApply) {
    function applyCurrentValue() {
      var value = readInputValue(scope, key, input);
      if (value !== undefined) onApply(key, value);
    }

    // Enter commits without reaching for the mouse - matches every other
    // "type then confirm" input in this app (chat, join-by-code password).
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') applyCurrentValue();
    });

    var applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'settingApplyBtn';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', applyCurrentValue);
    controls.appendChild(applyBtn);

    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'settingResetBtn';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Reset to default';
    resetBtn.addEventListener('click', function () {
      var def = defaultValueFor(scope, key);
      if (def === undefined) return;
      setInputDisplayValue(entry, input, def);
      onApply(key, def);
    });
    controls.appendChild(resetBtn);
  }

  row.appendChild(controls);
  return row;
}

// Builds one label+input row per key in `values`, grouped by category.
// With subTabsEl (Group panel), each category becomes a clickable pill;
// without it (Match panel), categories render as inline headers. Anything
// not mentioned by a category still renders, so a new server setting is
// never silently dropped.
function buildSettingsPanel(rowsEl, scope, values, subTabsEl, onApply) {
  rowsEl.textContent = '';

  var shown = {};
  var categories = categoriesFor(scope);
  var catNames = [];

  for (var catName in categories) {
    var keys = categories[catName].filter(function (k) { return values[k] !== undefined; });
    if (!keys.length) continue;
    catNames.push(catName);

    if (!subTabsEl) {
      var title = document.createElement('div');
      title.className = 'physicsCategoryTitle';
      title.textContent = catName;
      rowsEl.appendChild(title);
    }

    for (var i = 0; i < keys.length; i++) {
      shown[keys[i]] = true;
      var row = buildSettingRow(scope, keys[i], values, onApply);
      if (subTabsEl) row.setAttribute('data-category', catName);
      rowsEl.appendChild(row);
    }
  }

  var hasOther = false;
  for (var key in values) {
    if (shown[key]) continue;
    var extraRow = buildSettingRow(scope, key, values, onApply);
    if (subTabsEl) {
      extraRow.setAttribute('data-category', 'Other');
      hasOther = true;
    }
    rowsEl.appendChild(extraRow);
  }
  if (hasOther) catNames.push('Other');

  if (subTabsEl) buildCategorySubTabs(subTabsEl, rowsEl, catNames);
}

var activePhysicsCategory = null;

function buildCategorySubTabs(subTabsEl, rowsEl, catNames) {
  subTabsEl.textContent = '';
  if (!catNames.length) return;
  if (catNames.indexOf(activePhysicsCategory) === -1) activePhysicsCategory = catNames[0];

  function showCategory(name) {
    activePhysicsCategory = name;
    var btns = subTabsEl.children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].textContent === name);
    }
    var rows = rowsEl.children;
    for (var j = 0; j < rows.length; j++) {
      rows[j].classList.toggle('hidden', rows[j].getAttribute('data-category') !== name);
    }
  }

  for (var i = 0; i < catNames.length; i++) {
    (function (name) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'subTabBtn';
      btn.textContent = name;
      btn.addEventListener('click', function () { showCategory(name); });
      subTabsEl.appendChild(btn);
    })(catNames[i]);
  }

  showCategory(activePhysicsCategory);
}

