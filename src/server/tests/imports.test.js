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

  it('should import 12 transactions and 0 transfers ', async () => {
    const filePath = path.join(__dirname, 'assets', 'coineda-export.cnd');
    const exportedFile = fs.readFileSync(filePath);
    const res = await request.post('/import').attach('files', exportedFile);
    expect(res.body).toStrictEqual({
      inserts: 12,
      duplicates: 0,
      errors: 0,
    });
  });
});
