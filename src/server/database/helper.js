const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.resolve(__dirname, 'coineda.db'));

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
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
  );
};

module.exports = {
  executeSelectQuery: executeSelectQuery,
  executeQuery: executeQuery,
  init: init,
};
