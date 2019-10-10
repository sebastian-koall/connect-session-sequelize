/**
 * Sequelize based session store.
 *
 * Author: Michael Weibel <michael.weibel@gmail.com>
 * License: MIT
 */
const CryptoJS = require('crypto-js');
const path = require('path');
const Op = require('sequelize').Op || {}; // eslint-disable-line global-require
require('dotenv').load();

const defaultOptions = {
  checkExpirationInterval: 15 * 60 * 1000, // The interval at which to cleanup expired sessions.
  expiration: 24 * 60 * 60 * 1000, // The maximum age (in milliseconds) of a valid session. Used when cookie.expires is not set.
  disableTouch: false, // When true, we will not update the db in the touch function call. Useful when you want more control over db writes.
};
const secretKey = process.env.SESSION_SECRET;

/**
 * Sequelize based session store.
 *
 * This is a fork from https://github.com/mweibel/connect-session-sequelize
 * In order to support encrypted data values
 */
class SequelizeStoreException extends Error {
  constructor(message) {
    super(message);
    this.name = 'SequelizeStoreException';
  }
}

module.exports = function SequelizeSessionInit(Store) {
  class SequelizeStore extends Store {
    constructor(options = {}) {
      super(options);
      this.options = options;
      this.debug = info => {
        if (options.debug) console.info(info);
      };

      if (!options.db) {
        throw new SequelizeStoreException('Database connection is required');
      }

      this.options = Object.assign(defaultOptions, this.options);

      this.startExpiringSessions();

      // Check if specific table should be used for DB connection
      if (options.table) {
        this.debug(`Using table: %s for sessions, ${options.table}`);
        // Get Specifed Table from Sequelize Object
        this.sessionModel =
          options.db[options.table] || options.db.models[options.table];
      } else {
        // No Table specified, default to ./model
        this.debug('No table specified, using default table.');
        this.sessionModel = options.db.import(path.join(__dirname, 'model'));
      }
    }

    sync() {
      return this.sessionModel.sync();
    }

    // Modified ---
    get(sid, fn) {
      this.debug(`SELECT "%s", ${sid}`);
      return this.sessionModel
          .findOne({ where: { sid } })
          .then(session => {
          if (!session) {
        this.debug(`Did not find session %s, ${sid}`);
        return null;
      }
      this.debug(`FOUND %s with data %s, ${sid}, ${session.data}`);
      const bytes = CryptoJS.AES.decrypt(session.data, secretKey);
      const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
      return decryptedData;
    })
    .asCallback(fn);
    }

    // Modified ---
    set(sid, data, fn) {
      this.debug(`INSERT "%s", ${sid}`);
      const stringData = JSON.stringify(data);
      const expires = this.expiration(data);
      const encryptedStringData = CryptoJS.AES.encrypt(
        stringData,
        secretKey,
      ).toString();

      let defaults = { data: encryptedStringData, expires };
      if (this.options.extendDefaultFields) {
        defaults = this.options.extendDefaultFields(defaults, data);
      }

      return this.sessionModel
          .findCreateFind({
            where: { sid },
            defaults,
            raw: false,
          })
          .spread(session => {
          let changed = false;
      const sessionTemp = session;
      Object.keys(defaults).forEach(key => {
        if (key === 'data') {
        return;
      }

      if (sessionTemp.dataValues[key] !== defaults[key]) {
        sessionTemp[key] = defaults[key];
        changed = true;
      }
    });
      if (sessionTemp.data !== encryptedStringData) {
        sessionTemp.data = encryptedStringData;
        changed = true;
      }
      if (changed) {
        sessionTemp.expires = expires;
        return sessionTemp.save().return(sessionTemp);
      }
      return sessionTemp;
    })
    .asCallback(fn);
    }

    touch(sid, data, fn) {
      this.debug(`TOUCH "%s", ${sid}`);
      if (this.options.disableTouch) {
        this.debug(`TOUCH skipped due to disableTouch "%s", ${sid}`);
        return fn();
      }

      const expires = this.expiration(data);

      return this.sessionModel
          .update({ expires }, { where: { sid } })
          .then(rows => rows)
    .asCallback(fn);
    }

    destroy(sid, fn) {
      this.debug(`DESTROYING %s, ${sid}`);
      return this.sessionModel
          .findOne({ where: { sid }, raw: false })
          .then(session => {
          // If the session wasn't found, then consider it destroyed already.
          if (session === null) {
        this.debug(`Session not found, assuming destroyed %s, ${sid}`);
        return null;
      }
      return session.destroy();
    })
    .asCallback(fn);
    }

    length(fn) {
      return this.sessionModel.count().asCallback(fn);
    }

    clearExpiredSessions(fn) {
      this.debug('CLEARING EXPIRED SESSIONS');
      return this.sessionModel
        .destroy({ where: { expires: { [Op.lt || 'lt']: new Date() } } })
        .asCallback(fn);
    }

    startExpiringSessions() {
      // Don't allow multiple intervals to run at once.
      this.stopExpiringSessions();
      if (this.options.checkExpirationInterval > 0) {
        this.expirationInterval = setInterval(
          this.clearExpiredSessions.bind(this),
          this.options.checkExpirationInterval,
        );
        // allow to terminate the node process even if this interval is still running
        this.expirationInterval.unref();
      }
    }

    stopExpiringSessions() {
      if (this.expirationInterval) {
        clearInterval(this.expirationInterval);
        // added as a sanity check for testing
        this.expirationInterval = null;
      }
    }

    expiration(data) {
      if (data.cookie && data.cookie.expires) {
        return data.cookie.expires;
      }
      return new Date(Date.now() + this.options.expiration);
    }
  }

  return SequelizeStore;
};
