const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-database-helper' });

const userPreferences =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? process.env.HOME + '/Library/Preferences'
    : process.env.HOME);

const coinedaPreferences = path.resolve(userPreferences, '.coineda');
const fs = require('fs');

if (!fs.existsSync(coinedaPreferences)) {
  fs.mkdirSync(coinedaPreferences);
}

let db;
if (process.env.NODE_ENV === 'test') {
  db = new sqlite3.Database(':memory:');
  logger.info('Setup in memory db due to testing mode.');
} else {
  db = new sqlite3.Database(path.resolve(coinedaPreferences, 'coineda.db'));
}

const executeSelectQuery = (query, params) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
};

const executeQuery = (query, params) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (error) {
      if (error) {
        reject(error);
      } else {
        resolve(this);
      }
    });
  });
};

const init = async () => {
  await executeQuery(
    'CREATE TABLE IF NOT EXISTS exchanges (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)'
  );
  await executeQuery(
    `CREATE TABLE IF NOT EXISTS assets
      (row_id INTEGER PRIMARY KEY, 
      id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL UNIQUE, 
      name TEXT NOT NULL,
      isFiat INTEGER DEFAULT 0,
      roughlyEstimatedInEuro REAL
    )`
  );
  await executeQuery(
    `CREATE TABLE IF NOT EXISTS transactions 
        (id INTEGER PRIMARY KEY, 
        type TEXT NOT NULL,
        exchange TEXT NOT NULL, 
        fromValue REAL NOT NULL, 
        fromCurrency TEXT NOT NULL, 
        toValue REAL NOT NULL, 
        toCurrency TEXT NOT NULL, 
        feeValue REAL NOT NULL, 
        feeCurrency TEXT NOT NULL,
        comment TEXT,
        date TIMESTAMP NOT NULL,
        isComposed INTEGER NOT NULL DEFAULT 0,
        parent INTEGER,
        composedKeys TEXT,
        account INTEGER DEFAULT 0,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
  );

  await executeQuery(
    `CREATE TABLE IF NOT EXISTS transfers 
        (id INTEGER PRIMARY KEY, 
        fromExchange TEXT NOT NULL,
        toExchange TEXT NOT NULL, 
        value REAL NOT NULL, 
        currency TEXT NOT NULL, 
        feeValue REAL NOT NULL, 
        feeCurrency TEXT NOT NULL,
        date TIMESTAMP NOT NULL,
        account INTEGER DEFAULT 0,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
  );

  await executeQuery(
    `CREATE TABLE IF NOT EXISTS accounts 
        (id INTEGER PRIMARY KEY, 
        name TEXT NOT NULL UNIQUE,
        pattern TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
  );

  const accounts = await executeSelectQuery('SELECT * FROM accounts');
  if (accounts.length === 0) {
    await executeQuery('INSERT INTO accounts (name, pattern) VALUES (?, ?)', [
      'Coineda',
      'DEFAULT7',
    ]);
  }

  const assets = await executeSelectQuery('SELECT * FROM assets');
  if (assets.length === 0) {
    const defaultAssets = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'assets.json'))
    );
    for (const asset of defaultAssets.fiat) {
      await executeQuery(
        'INSERT INTO assets (id, symbol, name, isFiat, roughlyEstimatedInEuro) VALUES (?, ?, ?, ?, ?)',
        [asset.id, asset.symbol, asset.name, 1, asset.roughly_estimated_in_euro]
      );
    }

    for (const asset of defaultAssets.cryptocurrencies) {
      await executeQuery(
        'INSERT INTO assets (id, symbol, name) VALUES (?, ?, ?)',
        [asset.id, asset.symbol, asset.name]
      );
    }
  }
};

module.exports = {
  executeSelectQuery: executeSelectQuery,
  executeQuery: executeQuery,
  init: init,
};
