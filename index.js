const axios = require('axios');
const packageJson = require('./package.json');

module.exports = (api) => {
  api.registerAccessory('homebridge-garage-control', GarageDoorOpener);
};

class GarageDoorOpener {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    // Konfigurationswerte mit Standardwerten
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

    // Authentifizierung konfigurieren
    this.auth = (this.username && this.password) ? { username: this.username, password: this.password } : null;

    // HomeKit-Dienste und Charakteristiken initialisieren
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

    // Initialisierung nach Start
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Homebridge fertig geladen.');
      if (this.polling) {
        this.startPolling();
      } else {
        this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 1); // Geschlossen als Standard
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 1);
      }
    });
  }

  // HTTP-Anfrage-Methode
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
      this.log.warn(`HTTP-Anfrage fehlgeschlagen: ${error.message}`);
      throw error;
    }
  }

  // Status abfragen
  async _getStatus() {
    if (!this.statusURL) return;
    this.log.debug(`Status abfragen: ${this.statusURL}`);
    try {
      const status = await this._httpRequest(this.statusURL, 'GET');
      const state = parseInt(status);
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, state);

      // Zielstatus basierend auf aktuellem Status aktualisieren
      if (state === 0 || state === 2) {
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 0); // Offen
      } else if (state === 1 || state === 3) {
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 1); // Geschlossen
      } else {
        this.service.updateCharacteristic(this.Characteristic.TargetDoorState, 0); // Standard: Offen
        this.log.warn(`Unbekannter Status: ${state}, setze auf 0`);
      }
      this.log.debug(`Status aktualisiert: ${state}`);
    } catch (error) {
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, new Error('Polling fehlgeschlagen'));
    }
  }

  // Zielstatus setzen
  async setTargetDoorState(value) {
    const url = value === 1 ? this.closeURL : this.openURL;
    this.log.debug(`Setze Zielstatus auf ${value === 0 ? 'Offen' : 'Geschlossen'}`);

    try {
      await this._httpRequest(url, this.httpMethod);
      this.service.updateCharacteristic(this.Characteristic.TargetDoorState, value);

      if (value === 1) {
        this.log('Starte Schließen');
        this.simulateClose();
      } else {
        this.log('Starte Öffnen');
        this.simulateOpen();
        if (this.switchOff) this.switchOffFunction();
        if (this.autoLock) this.autoLockFunction();
      }
    } catch (error) {
      this.log.warn(`Fehler beim Setzen des Zielstatus: ${error.message}`);
      throw error;
    }
  }

  // Simulation des Öffnens
  simulateOpen() {
    this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 2); // Öffnen läuft
    setTimeout(() => {
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 0); // Offen
      this.log('Öffnen abgeschlossen');
    }, this.openTime * 1000);
  }

  // Simulation des Schließens
  simulateClose() {
    this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 3); // Schließen läuft
    setTimeout(() => {
      this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, 1); // Geschlossen
      this.log('Schließen abgeschlossen');
    }, this.closeTime * 1000);
  }

  // Automatisches Schließen
  autoLockFunction() {
    this.log(`Warte ${this.autoLockDelay} Sekunden für Autolock`);
    setTimeout(() => {
      this.log('Autolocking...');
      this.service.setCharacteristic(this.Characteristic.TargetDoorState, 1);
    }, this.autoLockDelay * 1000);
  }

  // Switch-Off-Funktion
  switchOffFunction() {
    this.log(`Warte ${this.switchOffDelay} Sekunden für Switch-Off`);
    setTimeout(async () => {
      this.log('SwitchOff...');
      try {
        await this._httpRequest(this.closeURL, this.httpMethod);
      } catch (error) {
        this.log.warn(`Switch-Off fehlgeschlagen: ${error.message}`);
      }
    }, this.switchOffDelay * 1000);
  }

  // Polling starten
  startPolling() {
    this._getStatus();
    setInterval(() => this._getStatus(), this.pollInterval * 1000);
  }

  // Identifikation (optional)
  identify() {
    this.log('Identify requested!');
    return Promise.resolve();
  }

  // Dienste bereitstellen
  getServices() {
    return [this.informationService, this.service];
  }
}
