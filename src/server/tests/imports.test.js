const fs = require('fs');
const path = require('path');
const supertest = require('supertest');
const app = require('../app.js');
const http = require('http');
const db = require('../database/helper');

describe('import tests', () => {
  let server;
  let request;

  beforeAll(async (done) => {
    server = http.createServer(app);
    await db.init();
    server.listen(done);
    request = supertest(server);
  });

  afterAll((done) => {
    server.close(done);
  });
  /*
  it('should import 12 transactions and 0 transfers ', async () => {
    const filePath = path.join(__dirname, 'assets', 'coineda-export.cnd');
    const exportedFile = fs.readFileSync(filePath);
    const response = await request
      .post('/import')
      .attach('files', exportedFile)
      .field('account', 0);
    expect(response.body).toStrictEqual({
      inserts: 12,
      duplicates: 0,
      errors: 0,
    });
  });

  it('should import 22 transactions from Binance Order History with 3 errors because of unknown symbols', async () => {
    const filePath = path.join(
      __dirname,
      'assets',
      'Export Order History-2021-10-01 22_52_47.xlsx'
    );

    const exportedFile = fs.readFileSync(filePath);
    const response = await request
      .post('/import')
      .field('type', 'binance_spot_order_history')
      .field('account', 0)
      .attach('files', exportedFile);

    expect(response.body).toStrictEqual({
      inserts: 22,
      duplicates: 0,
      errors: 3,
    });
  }, 20000);
  */
  it('should import 65 Kraken transactions from csv export', async () => {
    const filePath = path.join(
      __dirname,
      'assets',
      'KrakenExport-2021-10-05.csv'
    );

    const exportedFile = fs.readFileSync(filePath);
    const response = await request
      .post('/import')
      .field('type', 'kraken_csv_export')
      .field('account', 0)
      .attach('files', exportedFile);

    expect(response.body).toStrictEqual({
      inserts: 25,
      duplicates: 0,
      errors: 2,
    });
  });
});
