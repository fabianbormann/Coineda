const supertest = require('supertest');
const app = require('../app.js');
const http = require('http');
const db = require('../database/helper');

describe('transaction tests', () => {
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

  it('should get all transactions', async () => {
    const res = await request.get('/transactions');
    expect(res.body).toStrictEqual([]);
  });

  it('should add a transaction', async () => {
    const res = await request.post('/transactions').send({
      exchange: 'Binance',
      fromValue: '29.05',
      fromCurrency: 'euro',
      toValue: '0.00067',
      toCurrency: 'bitcoin',
      feeValue: '0.00000067',
      feeCurrency: 'bitcoin',
      date: '2021-09-07 11:43:19',
      account: 0,
    });
    expect(res.status).toBe(200);
  });

  it('should get all transactions of account 0', async () => {
    const res = await request.get('/transactions/0');
    expect(res.body.length).toBe(1);
  });

  it('should add swap transaction', async () => {
    const res = await request.post('/transactions').send({
      exchange: 'Binance',
      fromValue: '0.00067',
      fromCurrency: 'bitcoin',
      toValue: '0.00914093',
      toCurrency: 'ethereum',
      feeValue: '0.0',
      feeCurrency: 'bitcoin',
      date: '2021-09-07 11:43:19',
      account: 0,
    });
    expect(res.status).toBe(200);
  });

  it('should get all transactions', async () => {
    const res = await request.get('/transactions');
    expect(res.body.length).toBe(4);
  });
});
