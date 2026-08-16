// schemaForm.js - generic settings-panel builder used by local/
// controlPanel.js's Settings tab. Every row is driven entirely by
// settingsState.settingsSchema (sent once by the server) - a new setting
// added server-side needs zero new code here. Each row applies itself the
// moment it changes (buildSettingRow's onChange) - there's no separate
// collect-the-diff-and-Apply step to duplicate per panel.

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

// onChange(key, value), if given, fires the moment this one field commits
// (a checkbox/select's 'change', or a number field's 'change' - i.e. on
// blur/Enter, not every keystroke) - a leader edits a field and it applies
// immediately, no separate Apply step for the per-field case.
function buildSettingRow(scope, key, values, onChange) {
  var entry = schemaEntryFor(scope, key);
  var row = document.createElement('label');
  row.className = 'settingRow';

  var name = document.createElement('span');
  name.textContent = formatKey(key) + (entry && entry.unit ? ' (' + entry.unit + ')' : '');
  row.appendChild(name);

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
  row.appendChild(input);

  if (onChange) {
    input.addEventListener('change', function () {
      var value = readInputValue(scope, key, input);
      if (value !== undefined) onChange(key, value);
    });
  }

  return row;
}

// Builds one label+input row per key in `values`, grouped by category.
// With subTabsEl (Group panel), each category becomes a clickable pill;
// without it (Match panel), categories render as inline headers. Anything
// not mentioned by a category still renders, so a new server setting is
// never silently dropped.
function buildSettingsPanel(rowsEl, scope, values, subTabsEl, onChange) {
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
      var row = buildSettingRow(scope, keys[i], values, onChange);
      if (subTabsEl) row.setAttribute('data-category', catName);
      rowsEl.appendChild(row);
    }
  }

  var hasOther = false;
  for (var key in values) {
    if (shown[key]) continue;
    var extraRow = buildSettingRow(scope, key, values, onChange);
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

