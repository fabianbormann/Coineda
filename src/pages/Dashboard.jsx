import React, { useCallback, useEffect, useState, useContext } from 'react';
import { Alert, Statistic, Card, Row, Col, message, Spin, Empty } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';

import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import axios from 'axios';
import { SettingsContext } from '../SettingsContext';
import WhenLambo from '../components/WhenLambo';
import DoughnutChart from '../components/DoughnutChart';

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

  const fetchSummary = useCallback(() => {
    setLoading(true);
    axios
      .get('http://localhost:5208/dashboard/summary/' + account.id)
      .then((response) => {
        setSummary(response.data);
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      })
      .finally(() => setLoading(false));
  }, [account]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

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
