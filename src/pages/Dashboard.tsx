import React, { useCallback, useEffect, useState, useContext } from 'react';

import { useTranslation } from 'react-i18next';

import { SettingsContext } from '../SettingsContext';
import WhenLambo from '../components/WhenLambo';
import DoughnutChart from '../components/DoughnutChart';
import storage from '../persistence/storage';

import { fetchPrice, isFiat, TransactionType } from '../helper/common';
import HistoryChart from '../components/HistoryChart';

import InfoIcon from '@mui/icons-material/Info';
import { CoinedaSummary, MessageType, Transaction } from '../global/types';
import {
  Alert,
  AlertTitle,
  Box,
  CircularProgress,
  Grid,
  Paper,
  Snackbar,
  Typography,
  useTheme,
} from '@mui/material';

import ArrowCircleDownIcon from '@mui/icons-material/ArrowCircleDown';
import ArrowCircleUpIcon from '@mui/icons-material/ArrowCircleUp';

const Dashboard = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { settings } = useContext(SettingsContext);
  const [summary, setSummary] = useState<CoinedaSummary>({
    cryptocurrencies: {},
    fiat: {},
  });
  const [loading, setLoading] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');

  const { account } = settings;

  const calculateSummary = useCallback(async () => {
    setLoading(true);

    const transactions = await storage.transactions.getAllFromAccount(
      account.id
    );

    const coins: CoinedaSummary = { cryptocurrencies: {}, fiat: {} };

    const calculateBalance = async (
      currency: string,
      value: number,
      add: boolean
    ) => {
      currency = currency.toLowerCase();
      const target = (await isFiat(currency)) ? 'fiat' : 'cryptocurrencies';

      coins[target][currency] = coins[target][currency] || {};

      if (coins[target][currency].hasOwnProperty('value')) {
        if (add) {
          coins[target][currency].value += value;
        } else {
          coins[target][currency].value -= value;
        }
      } else {
        if (add) {
          coins[target][currency].value = value;
        } else {
          coins[target][currency].value = -value;
        }
      }
    };

    const assets = await storage.assets.getAllFiat();

    const calculatePurchasePrice = (transaction: Transaction) => {
      const targetCurrency = transaction.toCurrency.toLowerCase();
      if (transaction.type === TransactionType.BUY) {
        let purchasePrice = transaction.fromValue / transaction.toValue;
        if (transaction.fromCurrency.toLowerCase() !== 'euro') {
          const fiat = assets.find(
            (currency) => currency.id === transaction.fromCurrency.toLowerCase()
          );
          purchasePrice =
            (transaction.fromValue * fiat['roughlyEstimatedInEuro']) /
            transaction.toValue;
        }

        if (
          coins.cryptocurrencies[targetCurrency].hasOwnProperty(
            'purchase_price'
          )
        ) {
          coins.cryptocurrencies[targetCurrency].purchase_prices.push(
            purchasePrice
          );
        } else {
          coins.cryptocurrencies[targetCurrency].purchase_prices = [
            purchasePrice,
          ];
        }
      }
    };

    for (const transaction of transactions) {
      const {
        fromValue,
        fromCurrency,
        toValue,
        toCurrency,
        feeValue,
        feeCurrency,
      } = transaction;

      if (
        transaction.type === TransactionType.BUY ||
        transaction.type === TransactionType.SELL
      ) {
        await calculateBalance(toCurrency, toValue, true);
        await calculateBalance(fromCurrency, fromValue, false);
        await calculateBalance(feeCurrency, feeValue, false);
        calculatePurchasePrice(transaction);
      }
    }

    coins['inconsistency'] = { negativeValue: [] };

    for (const coin of Object.keys(coins.cryptocurrencies)) {
      if (coins.cryptocurrencies[coin].value === 0) {
        delete coins.cryptocurrencies[coin];
      } else if (coins.cryptocurrencies[coin].value < 0) {
        coins.inconsistency.negativeValue.push({
          ...coins.cryptocurrencies[coin],
          name: coin,
        });
        delete coins.cryptocurrencies[coin];
      } else {
        coins.cryptocurrencies[coin].avg_purchase_price =
          coins.cryptocurrencies[coin].purchase_prices.reduce(
            (previous, current) => current + previous,
            0
          ) / coins.cryptocurrencies[coin].purchase_prices.length;
      }
    }

    try {
      const ids = Object.keys(coins.cryptocurrencies);
      const data = await fetchPrice(ids);

      for (const coin in data) {
        coins.cryptocurrencies[coin].price_in_euro =
          data[coin] * coins.cryptocurrencies[coin].value;
        coins.cryptocurrencies[coin].current_price = data[coin];
        coins['crypto_total_in_euro'] = coins['crypto_total_in_euro'] || 0;
        coins['crypto_total_in_euro'] +=
          coins.cryptocurrencies[coin].price_in_euro;
      }

      setSummary(coins);
      setLoading(false);
    } catch (error) {
      console.error(error);
      setSnackbarType('error');
      setSnackbarMessage('Unable to fetch meta data from coingecko.');
      setSnackbarOpen(true);
      setLoading(false);
      return;
    }
  }, [account]);

  useEffect(() => {
    calculateSummary();
  }, [calculateSummary]);

  const data = [];
  let total = 0;
  let currencies = [];

  if (summary.hasOwnProperty('crypto_total_in_euro')) {
    for (const account of Object.keys(summary.cryptocurrencies)) {
      currencies.push(account);
      data.push({
        type: account.replace('-', ' '),
        Amount: summary.cryptocurrencies[account].value,
        value:
          Math.round(summary.cryptocurrencies[account].price_in_euro * 100) /
          100,
      });
    }

    total = summary.crypto_total_in_euro || 0;
  }

  const handleSnackbarClose = (
    event?: React.SyntheticEvent | Event,
    reason?: string
  ) => {
    if (reason === 'clickaway') {
      return;
    }

    setSnackbarOpen(false);
  };

  return (
    <Grid container justifyContent="center" alignItems="center" sx={{ p: 2 }}>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={handleSnackbarClose}
      >
        <Alert
          onClose={handleSnackbarClose}
          severity={snackbarType}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>

      {loading && (
        <div>
          <CircularProgress />
        </div>
      )}
      {summary.hasOwnProperty('inconsistency') &&
        summary.inconsistency?.negativeValue.map((coin) => (
          <Alert severity="warning">
            <AlertTitle>Inconsistency warning</AlertTitle>
            {`You have a negative ${coin.name} value of ${coin.value}. Please check your transactions.`}
          </Alert>
        ))}
      {summary.hasOwnProperty('crypto_total_in_euro') ? (
        <>
          <Grid container spacing={2}>
            <Grid item sm={12} md={9} lg={6}>
              <Paper>
                <HistoryChart currencies={currencies} />
              </Paper>
            </Grid>
            <Grid item sm={12} md={9} lg={6}>
              <Paper>
                <DoughnutChart
                  label={`${Math.round(total * 100) / 100} €`}
                  data={data}
                />
              </Paper>
            </Grid>
          </Grid>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            {Object.keys(summary.cryptocurrencies).map((account) => {
              const change =
                summary.cryptocurrencies[account].price_in_euro /
                  (summary.cryptocurrencies[account].avg_purchase_price *
                    summary.cryptocurrencies[account].value) -
                1;
              return (
                <Grid item sm={6} md={3} lg={2} key={account}>
                  <Paper sx={{ p: 2 }}>
                    <Typography
                      style={{
                        textTransform: 'capitalize',
                      }}
                    >
                      {account.replace('-', ' ')}
                    </Typography>
                    <Box
                      sx={{
                        display: 'flex',
                        color:
                          change > 0
                            ? theme.palette.success.main
                            : theme.palette.error.main,
                      }}
                    >
                      <>
                        {change > 0 ? (
                          <ArrowCircleUpIcon />
                        ) : (
                          <ArrowCircleDownIcon />
                        )}
                        <Typography
                          sx={{
                            ml: 1,
                            fontSize: '1rem',
                          }}
                        >{`${Math.round(change * 10000) / 100}%`}</Typography>
                      </>
                    </Box>
                  </Paper>
                </Grid>
              );
            })}
          </Grid>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid item sm={12} md={6}>
              <WhenLambo value={summary?.crypto_total_in_euro || 0} />
            </Grid>
          </Grid>
        </>
      ) : (
        !loading && (
          <Grid
            container
            direction="column"
            justifyContent="center"
            alignItems="center"
          >
            <InfoIcon sx={{ mt: 2 }} />
            <p>{t('No Transactions') as string}</p>
          </Grid>
        )
      )}
    </Grid>
  );
};

export default Dashboard;
