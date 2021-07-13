const express = require('express');
const app = express();
const PORT = 5208;

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('coineda.db');

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
    db.run(query, params, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

app.get('/alive', (req, res) => {
  return res.status(200).end();
});

app.get('/exchange', async (req, res) => {
  const sql = 'SELECT * FROM exchanges';
  const exchanges = await executeSelectQuery(sql);
  return res.json(exchanges);
});

const server = app.listen(PORT, async () => {
  console.log('Coineda backend listening on localhost port ' + PORT);

  await executeQuery(
    'CREATE TABLE IF NOT EXISTS exchanges (id PRIMARY KEY, name TEXT NOT NULL UNIQUE)'
  );
});

exports.server = server;
