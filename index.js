const axios = require('axios');
const packageJson = require('./package.json');

module.exports = (api) => {
  api.registerPlatform('homebridge-garage-control', GarageDoorControlPlatform);
};

class GarageDoorControlPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessoryList = [new GarageDoorControl(log, config, api)];
  }

  accessories(callback) {
    callback(this.accessoryList);
  }
}

class GarageDoorControl {
  lastStatusText = undefined;
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    // Configuration values with defaults
    this.name = config.name;
    this.openURL = config.openURL;
    this.closeURL = config.closeURL;
    this.openTime = config.openTime || 10;
    this.closeTime = config.closeTime || 10;
    this.switchOff = config.switchOff || false;
    this.switchOffDelay = config.switchOffDelay || 2;
    this.autoLock = config.autoLock || false;
    this.autoLockDelay = config.autoLockDelay || 20;
    this.manufacturer = config.manufacturer || packageJson.author?.name || 'Unknown';
    this.serial = config.serial || packageJson.version;
    this.model = config.model || packageJson.name;
    this.firmware = config.firmware || packageJson.version;
    this.username = config.username || null;
    this.password = config.password || null;
    this.timeout = config.timeout || 3000;
    this.httpMethod = config.http_method || 'GET';
    this.polling = config.polling || false;
    this.pollInterval = config.pollInterval || 120;
    this.statusURL = config.statusURL;
    // Konfigurierbare Statuswerte als normalisierte Vergleichswerte
    this.openStatusValues = this.parseStatusValues(config.openStatusValues, ['0', '2', 'open', 'offen']);
    this.closedStatusValues = this.parseStatusValues(config.closedStatusValues, ['1', '3', 'closed', 'geschlossen']);

    // Configure authentication
    this.auth = (this.username && this.password) ? { username: this.username, password: this.password } : null;

    // Initialize HomeKit services and characteristics
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.informationService = new this.Service.AccessoryInformation()
      .setCharacteristic(this.Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(this.Characteristic.Model, this.model)
      .setCharacteristic(this.Characteristic.SerialNumber, this.serial)
      .setCharacteristic(this.Characteristic.FirmwareRevision, this.firmware);

    this.service = new this.Service.GarageDoorOpener(this.name);
    this.service.getCharacteristic(this.Characteristic.TargetDoorState)
      .onSet(this.setTargetDoorState.bind(this));

    // Initialization after start
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Homebridge finished loading.');
      if (this.polling) {
        this.startPolling();
      } else {
        this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 1); // Closed as default
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 1);
      }
    });
  }

  parseStatusValues(value, fallback) {
    const normalizeEntries = (entries) => {
      const values = entries
        .map((entry) => this.normalizeStatusValue(entry))
        .filter((entry) => entry !== null);
      return values.length > 0 ? values : fallback;
    };

    if (Array.isArray(value)) {
      return normalizeEntries(value);
    }

    if (typeof value === 'string') {
      return normalizeEntries(value.split(','));
    }

    return fallback;
  }

  normalizeStatusValue(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = String(value).trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  // HTTP request method
  async _httpRequest(url, method = 'GET', data = '') {
    try {
      const response = await axios({
        url,
        method,
        data,
        timeout: this.timeout,
        auth: this.auth,
        httpsAgent: new require('https').Agent({ rejectUnauthorized: false }),
      });
      return response.data;
    } catch (error) {
      this.log.warn(`HTTP request failed: ${error.message}`);
      throw error;
    }
  }

  // Get status
  async _getStatus() {
    if (!this.statusURL) return;
    this.log.info(`Polling status: ${this.statusURL}`);
    try {
      const status = await this._httpRequest(this.statusURL, 'GET');
      const normalizedState = this.normalizeStatusValue(status);
      // Prüfe, ob der Status zu 'offen' oder 'geschlossen' gehört
      let statusText = 'unknown';
      if (normalizedState !== null && this.openStatusValues.includes(normalizedState)) {
        this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 0); // Open
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 0); // Open
        statusText = 'open';
      } else if (normalizedState !== null && this.closedStatusValues.includes(normalizedState)) {
        this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 1); // Closed
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 1); // Closed
        statusText = 'closed';
      } else {
        const numericState = Number.parseInt(normalizedState, 10);
        this.service.updateCharacteristic(
          this.Characteristic.CurrentDoorState,
          Number.isNaN(numericState) ? 4 : numericState,
        );
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 0); // Default: Open
        this.log.warn(`Unknown state: ${status}, setting TargetDoorState to 0`);
        statusText = `unknown (value: ${status})`;
      }
      if (statusText !== this.lastStatusText) {
        this.log.info(`Status updated: ${statusText}`);
        this.lastStatusText = statusText;
      }
    } catch (error) {
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, new Error('Polling failed'));
    }
  }

  // Set target state
  async setTargetDoorState(value) {
    const url = value === 1 ? this.closeURL : this.openURL;
    this.log.debug(`Setting target state to ${value === 0 ? 'Open' : 'Closed'}`);

    try {
      await this._httpRequest(url, this.httpMethod);
      this.service.updateCharacteristic(this.Characteristic.TargetDoorState, value);

      if (value === 1) {
        this.log('Starting Close');
        this.simulateClose();
      } else {
        this.log('Starting Open');
        this.simulateOpen();
        if (this.switchOff) this.switchOffFunction();
        if (this.autoLock) this.autoLockFunction();
      }
    } catch (error) {
      this.log.warn(`Error setting target state: ${error.message}`);
      throw error;
    }
    // ...existing code...
  }

  // Simulate opening
  simulateOpen() {
    this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 2); // Opening in progress
    setTimeout(() => {
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 0); // Open
      this.log('Opening completed');
    }, this.openTime * 1000);
  }

  // Simulate closing
  simulateClose() {
    this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 3); // Closing in progress
    setTimeout(() => {
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 1); // Closed
      this.log('Closing completed');
    }, this.closeTime * 1000);
  }

  // Auto lock function
  autoLockFunction() {
    this.log(`Waiting ${this.autoLockDelay} seconds for Autolock`);
    setTimeout(() => {
      this.log('Autolocking...');
      this.service.setCharacteristic(this.Characteristic.TargetDoorState, 1);
    }, this.autoLockDelay * 1000);
  }

  // Switch-Off function
  switchOffFunction() {
    this.log(`Waiting ${this.switchOffDelay} seconds for Switch-Off`);
    setTimeout(async () => {
      this.log('SwitchOff...');
      try {
        await this._httpRequest(this.closeURL, this.httpMethod);
      } catch (error) {
        this.log.warn(`Switch-Off failed: ${error.message}`);
      }
    }, this.switchOffDelay * 1000);
  }

  // Start polling
  startPolling() {
    this._getStatus();
    setInterval(() => this._getStatus(), this.pollInterval * 1000);
  }

  // Identification (optional)
  identify() {
    this.log('Identify requested!');
    return Promise.resolve();
  }

  // Provide services
  getServices() {
    return [this.informationService, this.service];
  }
}
