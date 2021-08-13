import React, { useCallback, useEffect, useState } from 'react';
import { Pie } from '@ant-design/charts';
import {
  Alert,
  Statistic,
  Card,
  Row,
  Col,
  Divider,
  Typography,
  message,
} from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';

import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import axios from 'axios';
const { Title } = Typography;

const useStyles = createUseStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    padding: 16,
  },
});

const Dashboard = () => {
  const { t } = useTranslation();
  const classes = useStyles();
  const [summary, setSummary] = useState({});

  const fetchSummary = useCallback(() => {
    axios
      .get('http://localhost:5208/summary')
      .then((response) => {
        setSummary(response.data);
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      });
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const data = [];
  let total = 0;

  if (summary.hasOwnProperty('crypto_total_in_euro')) {
    for (const account of Object.keys(summary.cryptocurrencies)) {
      data.push({
        type: account,
        Amount: summary.cryptocurrencies[account].value,
        value:
          Math.round(summary.cryptocurrencies[account].price_in_euro * 100) /
          100,
      });
    }

    total = summary.crypto_total_in_euro;
  }

  const config = {
    appendPadding: 35,
    data,
    angleField: 'value',
    colorField: 'type',
    radius: 1,
    innerRadius: 0.6,
    label: {
      type: 'inner',
      offset: '-50%',
      style: { textAlign: 'center' },
      autoRotate: true,
      content: '{value}',
    },
    interactions: [{ type: 'element-active' }],
    tooltip: {
      fields: ['key', 'Amount'],
    },
    statistic: {
      title: {
        style: {
          whiteSpace: 'pre-wrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontSize: '100%',
        },
        content: 'Account Balance (EUR)',
      },
      content: {
        style: {
          whiteSpace: 'pre-wrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          paddingTop: '2%',
          fontSize: '120%',
        },
        content: Math.round(total * 100) / 100,
      },
    },
  };

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Dashboard')}</Title>
      <Divider />
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
        <Row gutter={0}>
          <Col span={24}>
            <Card>
              <Pie {...config} />
            </Card>
          </Col>
          {Object.keys(summary.cryptocurrencies).map((account) => {
            const change =
              summary.cryptocurrencies[account].price_in_euro /
                (summary.cryptocurrencies[account].purchase_price *
                  summary.cryptocurrencies[account].value) -
              1;
            return (
              <Col span={12} key={account}>
                <Card>
                  <Statistic
                    title={account}
                    value={change}
                    precision={4}
                    valueStyle={
                      change > 0 ? { color: '#3f8600' } : { color: '#cf1322' }
                    }
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
      ) : null}
    </div>
  );
};

export default Dashboard;
