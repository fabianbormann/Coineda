import { Alert, AlertTitle, CircularProgress, Grid } from '@mui/material';
import axios from 'axios';
import React, { ReactNode, useCallback, useRef } from 'react';
import { useEffect, useState, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResponsiveContainer,
  Line,
  LineChart,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
} from 'recharts';
import { HistoryChartProps, MarketPriceData } from '../global/types';
import { fetchPrice, getCoinCount, getPurchaseValue } from '../helper/common';
import { SettingsContext } from '../SettingsContext';

const HistoryChart = (props: HistoryChartProps) => {
  const { currencies } = props;
  const { settings } = useContext(SettingsContext);
  const [data, setData] = useState<Array<MarketPriceData>>([]);
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'waiting' | 'error'>(
    'loading'
  );
  const [progress, setProgress] = useState(0);
  const [countdown, setCountdown] = useState(-1);
  const fetchQueue = useRef<NodeJS.Timeout | undefined>();
  const { t } = useTranslation();

  const { account } = settings;

  const collectData = useCallback(async () => {
    const monthNames = [
      t('January'),
      t('February'),
      t('March'),
      t('April'),
      t('May'),
      t('June'),
      t('July'),
      t('August'),
      t('September'),
      t('October'),
      t('November'),
      t('December'),
    ];
    const today = new Date();

    const totalRequests = currencies.length * 6 + 6;
    let finishedRequests = 0;

    try {
      let marketPrices: Array<MarketPriceData> = [];
      for (var i = 6; i >= 0; i -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const month = monthNames[date.getMonth()];

        let values: { [key: string]: number } = {};

        if (i === 0) {
          values = await fetchPrice(currencies);
          finishedRequests += 1;
          setProgress(Math.round((finishedRequests / totalRequests) * 100));
        } else {
          for (const currency of currencies) {
            const currencyPrice = await fetchPrice(currency, date);
            values[currency] = currencyPrice;
            finishedRequests += 1;
            setProgress(Math.round((finishedRequests / totalRequests) * 100));
          }
        }

        let marketPrice = 0;
        for (const currency in values) {
          let currencyCount = await getCoinCount(currency, date, account.id);
          marketPrice += values[currency] * currencyCount;
        }

        marketPrices.push({
          name: month,
          short: month.substring(0, 3),
          unit: 'Eur',
          Value: Math.round(marketPrice * 100) / 100,
        });
      }
      setData(marketPrices);
      setState('ready');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (!error.response && error.code === 'ERR_NETWORK') {
          setState('waiting');
          setCountdown(90);
        } else {
          setState('error');
        }
      } else {
        setState('error');
      }
    }
  }, [currencies, account, t]);

  useEffect(() => {
    if (countdown === 0) {
      setCountdown(-1);
      setState('loading');
      collectData();
    } else if (countdown > 0) {
      const timeout = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timeout);
    }
  }, [countdown, collectData]);

  useEffect(() => {
    const calculatePurchasePrice = async () => {
      let value = 0;
      for (const currency of currencies) {
        value += await getPurchaseValue(currency, account.id);
      }
      setPurchasePrice(value);
    };

    if (fetchQueue.current) {
      clearTimeout(fetchQueue.current);
    }
    fetchQueue.current = setTimeout(collectData, 1000);
    calculatePurchasePrice();

    return () => {
      clearTimeout(fetchQueue.current);
    };
  }, [currencies, account, t, collectData]);

  let content = (
    <Grid container sx={{ alignItems: 'center', justifyContent: 'center' }}>
      <CircularProgress variant="determinate" value={progress} />
    </Grid>
  );
  if (state === 'error') {
    content = (
      <Grid container>
        <Alert
          severity="warning"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexGrow: 1,
            flexDirection: 'column',
            '& 	.MuiAlert-icon': {
              fontSize: '3.5rem',
            },
          }}
        >
          <AlertTitle sx={{ mb: 0, textAlign: 'center' }}>
            {t('Error while fetching historical data')}
          </AlertTitle>
        </Alert>
      </Grid>
    );
  } else if (state === 'waiting') {
    content = (
      <Grid container>
        <Alert
          severity="info"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexGrow: 1,
            flexDirection: 'column',
            '& 	.MuiAlert-icon': {
              fontSize: '3.5rem',
            },
          }}
        >
          <AlertTitle sx={{ mb: 0, textAlign: 'center' }}>
            {t("CoinGecko's API limit has been reached", {
              countdown: countdown,
            })}
          </AlertTitle>
        </Alert>
      </Grid>
    );
  } else if (state === 'ready') {
    content = (
      <LineChart data={data}>
        <XAxis dataKey="short" />
        <YAxis domain={['auto', 'auto']} />
        <Tooltip
          labelFormatter={(label: any, payload) => {
            if (payload.length > 0) {
              return payload[0].payload.name as ReactNode;
            }
            return label as ReactNode;
          }}
          formatter={(value) => value + ' €'}
        />
        <Line
          type="monotone"
          dot={false}
          dataKey="Value"
          stroke="#03A678"
          strokeWidth={2}
        />
        <ReferenceLine
          y={purchasePrice}
          stroke="#rgba(0, 0, 0, 0.87)"
        ></ReferenceLine>
      </LineChart>
    );
  }

  return (
    <ResponsiveContainer debounce={1} maxHeight={300} width="100%" aspect={1.4}>
      {content}
    </ResponsiveContainer>
  );
};

export default HistoryChart;
