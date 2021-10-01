import { useTranslation } from 'react-i18next';
import {
  Divider,
  Typography,
  Empty,
  message,
  Spin,
  DatePicker,
  Statistic,
  Button,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import { useState, useContext, useCallback, useEffect } from 'react';
import { SettingsContext } from '../SettingsContext';
import axios from 'axios';
import moment from 'moment';
import GainSummary from '../components/GainSummary';

const { Title } = Typography;

const useStyles = createUseStyles({
  actions: {
    marginTop: 0,
    marginBottom: 12,
  },
  divider: {
    marginTop: 12,
    marginBottom: 12,
  },
  negative: {
    color: '#cf1322',
  },
  positive: {
    color: '#3f8600',
  },
  page: {
    padding: 16,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  summary: {
    marginTop: 24,
    marginBottom: 12,
  },
});

const TaxReports = () => {
  const { t } = useTranslation();
  const classes = useStyles();
  const [settings] = useContext(SettingsContext);
  const [summary, setSummary] = useState({
    realizedGains: {},
    unrealizedGains: {},
  });
  const [selectedYear, setSelectedYear] = useState(new Date());
  const [loading, setLoading] = useState(false);

  const { account } = settings;

  const fetchSummary = useCallback(() => {
    setLoading(true);
    axios
      .get('http://localhost:5208/tax/' + account.id)
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

  const roundFiat = (value) => Math.round(value * 100) / 100;

  const realizedWithinTaxYear = {};
  for (const coin of Object.keys(summary.realizedGains)) {
    realizedWithinTaxYear[coin] = summary.realizedGains[coin].filter(
      (transaction) =>
        new Date(transaction.date) >
          new Date(selectedYear.getFullYear(), 0, 1) &&
        new Date(transaction.date) <
          new Date(selectedYear.getFullYear(), 11, 31)
    );
  }

  const unrealizedAfterTaxYear = {};
  for (const coin of Object.keys(summary.unrealizedGains)) {
    unrealizedAfterTaxYear[coin] = summary.unrealizedGains[coin].filter(
      (transaction) =>
        new Date(new Date(transaction.date).getFullYear(), 0, 1) <=
        new Date(selectedYear.getFullYear(), 0, 1)
    );
  }

  let totalGain = 0;
  for (const coin of Object.keys(realizedWithinTaxYear)) {
    totalGain += realizedWithinTaxYear[coin].reduce(
      (previous, current) => previous + current.gain,
      0
    );
  }

  const hasLoss = totalGain < 0;
  const isBelowLimit = totalGain < 600;
  const tax = isBelowLimit ? 0 : totalGain * 0.5;

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tax Reports')}</Title>
      <Divider className={classes.actions} />

      {loading && <Spin />}

      {!loading && (
        <DatePicker
          style={{ maxWidth: 200 }}
          value={moment(selectedYear)}
          onChange={(date, dateString) => setSelectedYear(new Date(dateString))}
          picker="year"
        />
      )}

      {Object.keys(realizedWithinTaxYear).length > 0 ||
      Object.keys(unrealizedAfterTaxYear).length > 0 ? (
        <div>
          <Statistic
            className={classes.summary}
            valueStyle={{ color: hasLoss ? '#cf1322' : '#3f8600' }}
            title={t('Taxable gains and losses')}
            value={`${hasLoss ? '-' : '+'}${roundFiat(
              Math.abs(totalGain)
            )} EUR`}
          />
          <p>
            {t('You need to pay', {
              approx: isBelowLimit ? ' ' : ` ${t('approx')} `,
            })}
            <span
              className={isBelowLimit ? classes.positive : classes.negative}
            >
              {isBelowLimit ? '' : '~'} {roundFiat(tax)} EUR
            </span>
            {t('Tax this year', { year: selectedYear.getFullYear() })}
          </p>
          <Button disabled={true} icon={<DownloadOutlined />}>
            {t('Download Report')}
          </Button>
          <Divider className={classes.divider} />
          <GainSummary
            title={t('Realized Gains')}
            gains={realizedWithinTaxYear}
          />
          <GainSummary
            title={t('Unrealized Gains')}
            gains={unrealizedAfterTaxYear}
          />
        </div>
      ) : (
        !loading && (
          <Empty
            description={t('No Transactions in ' + selectedYear.getFullYear())}
          />
        )
      )}
    </div>
  );
};

export default TaxReports;
