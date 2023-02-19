import {
  Grid,
  Link,
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material';
import React from 'react';
import { MandatoryImportField } from '../../global/types';
import { ApiSyncSource } from '../ApiSyncSource';
import axios from 'axios';
import { sha256 } from 'js-sha256';
import qs from 'qs';
import { TFunction } from 'i18next';

export default class BinanceApiSync extends ApiSyncSource {
  hasDescription: boolean = true;
  descriptionTitle?: string = 'How to get an API key?';
  name: string = 'BinanceApiSync';
  label: string = 'Binance API';
  url: string = 'https://api.binance.com';

  async fetch(config: { [key: string]: string }) {
    const timestamp = Date.now();
    const signature = sha256.hmac
      .create(config['binanceSecretKey'])
      .update(qs.stringify({ timestamp }))
      .hex();

    const axiosConfig = {
      method: 'GET',
      url: `${this.url}/api/v3/account`,
      headers: {
        'X-MBX-APIKEY': config['binanceApiKey'],
      },
      params: {
        timestamp,
        signature,
      },
    };

    const account = await axios(axiosConfig);
    console.log(account.data);
  }

  getMandatoryFields(): MandatoryImportField[] {
    return [
      {
        name: 'binanceApiKey',
        label: 'API Key',
        description: 'Your Binance API Key',
      },
      {
        name: 'binanceSecretKey',
        label: 'Secret Key',
        description: 'Your Binance Secret Key',
      },
    ];
  }

  getDescription(
    t: TFunction<'translation', undefined, 'translation'>
  ): JSX.Element {
    return (
      <Grid>
        <Typography>
          {t('Please visit')}{' '}
          <Link
            href="https://www.binance.com/en/binance-api"
            target="_blank"
            rel="noreferrer"
          >
            https://www.binance.com/en/binance-api
          </Link>{' '}
          {t('and follow these steps:')}
        </Typography>
        <List dense sx={{ display: 'flex', flexDirection: 'column' }}>
          <ListItem>
            <ListItemText>
              {t('1. Log into your Binance account, and click')}{' '}
              <Link
                target="_blank"
                rel="noreferrer"
                href="https://www.binance.com/en/my/settings/api-management"
              >
                {t('API Management')}
              </Link>{' '}
              {t('from the user center icon.')}
            </ListItemText>
          </ListItem>
          <ListItem>
            <ListItemText>
              {t(
                '2. Enter a label/name for your API key (e.g. CoinedaApiKey) and click [Create API].'
              )}
            </ListItemText>
          </ListItem>
          <ListItem>
            <ListItemText>
              {t(
                '3. You only need to check "Enable Reading" within the "API restrictions" section'
              )}
            </ListItemText>
          </ListItem>
          <ListItem>
            <ListItemText>
              {t(
                '4. Complete the security verification with your registered 2FA devices.'
              )}
            </ListItemText>
          </ListItem>
        </List>
      </Grid>
    );
  }
}
