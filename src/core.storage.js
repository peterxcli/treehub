/**
 * Settings and state of TreeHub in chrome.storage.local. Changes of "treehub.*" keys, from any page or the
 * background worker, trigger EVENT.STORE_CHANGE on this object with {key: [oldValue, newValue]}.
 */
class ExtStore {
  constructor(values, defaults) {
    this._tempChanges = {};

    // Default values of the settings
    this._init = Promise.all(
      Object.keys(values).map(async (key) => {
        if ((await this._innerGet(values[key])) == null) {
          await this._innerSet(values[key], defaults[key]);
        }
      })
    ).then(() => {
      this._init = null;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        Object.entries(changes).forEach(([key, change]) => {
          if (key.startsWith('treehub')) this._notifyChange(key, change.oldValue, change.newValue);
        });
      });
    });
  }

  // Debounce and group the trigger of EVENT.STORE_CHANGE because the
  // changes are all made one by one
  _notifyChange(key, oldVal, newVal) {
    this._tempTimer && clearTimeout(this._tempTimer);
    this._tempChanges[key] = [oldVal, newVal];
    this._tempTimer = setTimeout(() => {
      $(this).trigger(EVENT.STORE_CHANGE, this._tempChanges);
      this._tempTimer = null;
      this._tempChanges = {};
    }, 50);
  }

  // Public. Once the extension is updated or reloaded, calls never settle: see util.context.js
  async set(key, value) {
    if (!isExtensionContextValid()) return whenExtensionContextLost();
    if (this._init) await this._init;
    return this._innerSet(key, value);
  }

  async get(key) {
    if (!isExtensionContextValid()) return whenExtensionContextLost();
    if (this._init) await this._init;
    return this._innerGet(key);
  }

  async remove(key) {
    if (!isExtensionContextValid()) return whenExtensionContextLost();
    if (this._init) await this._init;
    return chrome.storage.local.remove(key);
  }

  // Private
  async _innerGet(key) {
    return (await chrome.storage.local.get(key))[key];
  }

  _innerSet(key, value) {
    return chrome.storage.local.set({[key]: value});
  }
}

window.extStore = new ExtStore(STORE, DEFAULTS);
