const axios = require('axios');
const packageJson = require('./package.json');

module.exports = (api) => {
  api.registerAccessory('homebridge-garage-control', 'homebridge-garage-control\n', GarageDoorOpener);
};

class GarageDoorOpener {
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
    this.log.debug(`Polling status: ${this.statusURL}`);
    try {
      const status = await this._httpRequest(this.statusURL, 'GET');
      const state = parseInt(status);
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, state);

      // Update target state based on current state
      if (state === 0 || state === 2) {
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 0); // Open
      } else if (state === 1 || state === 3) {
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 1); // Closed
      } else {
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 0); // Default: Open
        this.log.warn(`Unknown state: ${state}, setting to 0`);
      }
      this.log.debug(`Status updated: ${state}`);
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
