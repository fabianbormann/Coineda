const express = require('express');
const router = express.Router();

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-transactions' });

const fs = require('fs');
const path = require('path');

const settingsPath = path.resolve(__dirname, '..', 'database', 'main.json');

router.get('/', (req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath));
    res.json(settings);
  } catch (error) {
    logger.error(error);
    res.status(500).send('Unable to read main.json');
  }
});

router.get('/language', (req, res) => {
  let settings = {};

  try {
    settings = JSON.parse(fs.readFileSync(settingsPath));
  } catch (error) {
    logger.error(error);
    return res.status(500).send('Unable to read main.json');
  }

  if (settings.hasOwnProperty('language')) {
    return res.send(settings.language);
  } else {
    let language = Intl.DateTimeFormat().resolvedOptions().locale;
    logger.info('Detected system language: ' + language);
    if (language.startsWith('de')) {
      language = 'de';
    } else if (language.startsWith('en')) {
      language = 'en';
    } else {
      logger.info(
        `Detected system language ${language} not supported using fallback 'en'`
      );
      language = 'en';
    }

    settings.language = language;
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, undefined, 2));
    } catch (error) {
      logger.warn('Unable to persist language within main.json settings file.');
    }

    res.send(language);
  }
});

router.post('/language', (req, res) => {
  let settings = {};

  try {
    settings = JSON.parse(fs.readFileSync(settingsPath));
  } catch (error) {
    logger.error(error);
    return res.status(500).send('Unable to read main.json');
  }

  settings.language = req.body.language;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, undefined, 2));
    res.status(200).end();
  } catch (error) {
    logger.warn(
      'Unable to persist language within main.json settings file.',
      error
    );
    res.status(500).end();
  }
});

module.exports = router;
