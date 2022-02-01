import React, { useCallback, useEffect, useState, useContext } from 'react';
import { Alert, Statistic, Card, Row, Col, message, Spin, Empty } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';

import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';

import { SettingsContext } from '../SettingsContext';
import WhenLambo from '../components/WhenLambo';
import DoughnutChart from '../components/DoughnutChart';
import storage from '../persistence/storage';

import { fetchPrice, isFiat, TransactionType } from '../helper/common';

const useStyles = createUseStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
  },
  title: {
    color: '#2F4858 !important',
    fontWeight: 600,
    fontSize: '1.5rem',
    marginBottom: 0,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
  },
});

const Dashboard = () => {
  const { t } = useTranslation();
  const classes = useStyles();
  const [settings] = useContext(SettingsContext);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);

  const { account } = settings;

  const calculateSummary = useCallback(async () => {
    setLoading(true);

    const transactions = await storage.transactions.getAllFromAccount(
      account.id
    );

    const coins = { cryptocurrencies: {}, fiat: {} };

    const calculateBalance = async (currency, value, add) => {
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

    const calculatePurchasePrice = (transaction) => {
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
          coins.cryptocurrencies[targetCurrency].purchase_price.push(
            purchasePrice
          );
        } else {
          coins.cryptocurrencies[targetCurrency].purchase_price = [
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
        coins.cryptocurrencies[coin].purchase_price =
          coins.cryptocurrencies[coin].purchase_price.reduce(
            (previous, current) => current + previous,
            0
          ) / coins.cryptocurrencies[coin].purchase_price.length;
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
      message.error('Unable to fetch meta data from coingecko.');
      setLoading(false);
      return;
    }
  }, [account]);

  useEffect(() => {
    calculateSummary();
  }, [calculateSummary]);

  const data = [];
  let total = 0;

  if (summary.hasOwnProperty('crypto_total_in_euro')) {
    for (const account of Object.keys(summary.cryptocurrencies)) {
      data.push({
        type: account.replace('-', ' '),
        Amount: summary.cryptocurrencies[account].value,
        value:
          Math.round(summary.cryptocurrencies[account].price_in_euro * 100) /
          100,
      });
    }

    total = summary.crypto_total_in_euro;
  }

  return (
    <div className={classes.page}>
      {loading && (
        <div className={classes.loading}>
          <Spin />
        </div>
      )}
      {summary.hasOwnProperty('inconsistency') &&
        summary.inconsistency.negativeValue.map((coin) => (
          <Alert
            message="Inconsistency warning"
            description={`You have a negative ${coin.name} value of ${coin.value}. Please check your transactions.`}
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            closable
          />
        ))}
      {summary.hasOwnProperty('crypto_total_in_euro') ? (
        <>
          <Row>
            <Col sm={24} md={18} lg={12}>
              <Card>
                <DoughnutChart
                  label={`${Math.round(total * 100) / 100} €`}
                  data={data}
                />
              </Card>
            </Col>
          </Row>
          <Row>
            {Object.keys(summary.cryptocurrencies).map((account) => {
              const change =
                summary.cryptocurrencies[account].price_in_euro /
                  (summary.cryptocurrencies[account].purchase_price *
                    summary.cryptocurrencies[account].value) -
                1;
              return (
                <Col sm={12} md={6} lg={4} key={account}>
                  <Card>
                    <Statistic
                      title={account.replace('-', ' ')}
                      value={Math.round(change * 10000) / 100}
                      precision={2}
                      style={{
                        textTransform: 'capitalize',
                        fontFamily: 'PTSerif',
                      }}
                      valueStyle={{
                        fontSize: '1rem',
                        color: change > 0 ? '#03A678' : '#C36491',
                      }}
                      prefix={
                        change > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />
                      }
                      suffix="%"
                    />
                  </Card>
                </Col>
              );
            })}
          </Row>
          <Row>
            <Col sm={24} md={12}>
              <WhenLambo value={summary.crypto_total_in_euro} />
            </Col>
          </Row>
        </>
      ) : (
        !loading && <Empty description={t('No Transactions')} />
      )}
    </div>
  );
};

export default Dashboard;
